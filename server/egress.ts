// 动态出口 IP: 发现 + 主/副选择 + 上游 fetch 注入。
//
// 背景: 本进程跑在宿主机网络命名空间 (Docker `network_mode: host`),
// 直接拥有全部出口 IP, 可用 node:http `localAddress` 精确选择源地址;
// 宿主机策略路由 (`ip rule from <副IP> lookup <表名>`) 自动走对应路由表。
//  - primary: 不绑定, 走默认路由 (与原来直连行为一致)。
//  - secondary: 在启用的副出口间按请求轮询。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fetchWithEgress, nodeHttpFetch } from "./http-fetch.js";

export interface EgressAddr {
  ip: string;
  /** 路由表名 (副出口), 主出口固定 "main"。 */
  name: string;
  public_ip: string;
  usable: boolean;
}

export interface Discovery {
  def: { ip: string; name: string; public_ip: string } | null;
  secondaries: EgressAddr[];
  updated_at: number;
}

function sh(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { encoding: "utf8", timeout: 5000 }).toString();
  } catch {
    return "";
  }
}

function readTableNames(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    for (const line of fs.readFileSync("/etc/iproute2/rt_tables", "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const parts = t.split(/\s+/);
      const id = parts[0];
      const name = parts[1];
      if (id && name) m.set(id, name);
    }
  } catch {
    /* ignore */
  }
  return m;
}

function isIpv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (!Number.isInteger(o) || o < 0 || o > 255) return false;
  }
  return true;
}

/** 同步发现 (纯本地命令, 无网络, 可高频调用; 公网探测走异步缓存)。 */
export function discoverSync(): Discovery {
  const names = readTableNames();
  const local = new Set<string>();
  for (const line of sh("ip", ["-o", "-4", "addr", "show", "scope", "global"]).split("\n")) {
    const m = line.match(/^\d+:\s+\S+\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/\d+\s+scope\s+global/);
    const ip = m?.[1];
    if (ip) local.add(ip);
  }
  let defSrc = "";
  for (const line of sh("ip", ["-o", "-4", "route", "show", "table", "main"]).split("\n")) {
    if (!line.trim().startsWith("default")) continue;
    const m = line.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/);
    const src = m?.[1];
    if (src) {
      defSrc = src;
      break;
    }
  }
  const secondaries: EgressAddr[] = [];
  const seen = new Set<string>();
  for (const line of sh("ip", ["-o", "-4", "rule", "show"]).split("\n")) {
    const m = line.match(/from\s+(\d+\.\d+\.\d+\.\d+)\s+lookup\s+(\S+)/);
    if (!m) continue;
    const rawIp = m[1];
    const rawTable = m[2];
    if (!rawIp || !rawTable) continue;
    let table = rawTable;
    if (/^\d+$/.test(table)) table = names.get(table) ?? table;
    if (["main", "default", "local", "unspec"].includes(table)) continue;
    const ip: string = rawIp;
    if (seen.has(ip) || ip === defSrc || !local.has(ip)) continue;
    seen.add(ip);
    const routes = sh("ip", ["-o", "-4", "route", "show", "table", table]);
    const usable = routes.split("\n").some((l) => l.trim().startsWith("default"));
    const cached = probeCache.get(ip);
    secondaries.push({ ip, name: /^[\w.-]{1,64}$/.test(table) ? table : "unknown", public_ip: cached?.publicIp ?? "", usable });
  }
  secondaries.sort((a, b) => (a.name < b.name ? -1 : 1));
  const defCached = probeCache.get("");
  return {
    def: defSrc && isIpv4(defSrc) ? { ip: defSrc, name: "main", public_ip: defCached?.publicIp ?? "" } : null,
    secondaries,
    updated_at: Date.now(),
  };
}

// ---- 公网探测缓存 (按源 IP, 6h 有效, 启动/周期异步刷新) ----
const probeCache = new Map<string, { publicIp: string; at: number }>();

async function probeSource(sourceIp: string): Promise<string> {
  for (const target of ["https://api.ipify.org", "https://ifconfig.me"]) {
    try {
      const res = await fetchWithEgressRaw(target, { method: "GET", signal: AbortSignal.timeout(10000) }, sourceIp || undefined);
      const text = (await res.text()).trim().split(/\s+/)[0] ?? "";
      if (/^(\d+\.\d+\.\d+\.\d+|[0-9a-fA-F:.]+)$/.test(text) && text.length <= 64) return text;
    } catch {
      /* 换下一个探测源 */
    }
  }
  return "";
}

let probing = false;
export async function refreshPublicIps(ips: string[]): Promise<void> {
  if (probing) return;
  probing = true;
  try {
    for (const src of ips) {
      const ip = await probeSource(src);
      probeCache.set(src, { publicIp: ip, at: Date.now() });
    }
  } finally {
    probing = false;
  }
}

/** 该源是否需要(重新)探测: 从未探过, 或上次失败已超 15 分钟 (成功的不重复打)。 */
export function needsProbe(src: string): boolean {
  const c = probeCache.get(src);
  if (!c) return true;
  if (c.publicIp) return false;
  return Date.now() - c.at > 15 * 60_000;
}

/** 底层绑定 fetch (node:http 实现, 见 http-fetch.ts; 与全局 fetch 同签名)。 */
function fetchWithEgressRaw(input: string, init: RequestInit = {}, egressIp?: string): Promise<Response> {
  if (!egressIp) return fetch(input, init);
  return nodeHttpFetch(input, init, egressIp);
}

export interface PickedEgress {
  /** 内网绑定 IP; "default" 表示未绑定走默认路由。 */
  ip: string;
  name: string;
  public_ip: string;
}

// 轮询计数 (单线程递增即原子)。
let rrCounter = 0;

/**
 * 按设置选择本次出口 (纯函数, 可单元测试):
 * - primary 或无可用副出口 -> 默认路由 (不绑定)。
 * - secondary -> 在有效启用列表上轮询。
 */
export function pickEgress(
  mode: "primary" | "secondary",
  enabledIps: string[],
  found: Discovery,
): PickedEgress {
  const usable = found.secondaries.filter((s) => s.usable);
  const want = enabledIps.filter(isIpv4);
  const list = want.length === 0 ? usable : usable.filter((s) => want.includes(s.ip));
  if (mode !== "secondary" || list.length === 0) {
    return { ip: "default", name: found.def?.name ?? "main", public_ip: found.def?.public_ip ?? "" };
  }
  const pick = list[(rrCounter = (rrCounter + 1) % list.length)]!;
  return { ip: pick.ip, name: pick.name, public_ip: pick.public_ip };
}

/** 供测试重置轮询计数。 */
export function resetRoundRobin(): void {
  rrCounter = 0;
}

/**
 * 构造单次请求的 fetchImpl: 首个上游调用时选择并钉死本次出口,
 * 同请求内后续调用复用; 调用方通过 getEgress() 记日志。
 *
 * 限流换出口重试: 免费层按 IP 限额, 429/503 时换一个出口重打一次
 * (副出口多启用时才有意义; 主模式/单出口时只退避不等价重试)。
 * 只在"上游尚未返回成功响应体"时重试: 成功响应 (含 SSE 流) 绝不重打,
 * 错误响应体会被完整消费后丢弃再重试, 不存在半截流。
 */
export function createRequestFetcher(
  mode: "primary" | "secondary",
  enabledIps: string[],
  found: Discovery,
): { fetchImpl: typeof fetch; getEgress: () => PickedEgress | null } {
  let egress: PickedEgress | null = null;
  const doFetch = (url: string, init: RequestInit, ip: string): Promise<Response> => {
    if (ip === "default") return fetch(url, init);
    return fetchWithEgress(ip)(url, init);
  };
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!egress) egress = pickEgress(mode, enabledIps, found);
    const first = await doFetch(url, init, egress.ip);
    if (first.status !== 429 && first.status !== 503) return first;
    // 可换的出口: 同有效列表中排除当前; 无可换则直接返回原响应 (透传限流)。
    const usable = found.secondaries.filter((s) => s.usable);
    const want = enabledIps.filter(isIpv4);
    const list = (want.length === 0 ? usable : usable.filter((s) => want.includes(s.ip))).filter(
      (s) => s.ip !== egress!.ip,
    );
    if (list.length === 0) return first;
    try {
      await first.text().catch(() => "");
    } catch {
      /* 消费原错误体后丢弃 */
    }
    const next = list[(rrCounter = (rrCounter + 1) % list.length)]!;
    egress = { ip: next.ip, name: next.name, public_ip: next.public_ip };
    return doFetch(url, init, egress.ip);
  }) as typeof fetch;
  return { fetchImpl, getEgress: () => egress };
}
