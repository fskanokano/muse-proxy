// muse-proxy 本地服务入口 (egress 分支)。
//
// 脱离 Supabase/Vercel 云环境, 本机常驻:
//  - /v1/*            原全部接口 (chat/completions, responses, messages, models),
//                     复用 supabase/functions/muse-proxy 的统一 handleRequest,
//                     上游 fetch 注入动态出口选择。
//  - /mp-healthz      存活探针。
//  - /admin/api/*     后台管理 API (登录/出口/日志)。
//  - /admin/*         后台管理 UI 静态。
//  - /                服务自述。
//
// SSE 长对话: requestTimeout=0 (无总时长掐断, 云函数 300s 上限本机不存在),
// 15s 心跳由各门面自带, 客户端断开才 abort 上游 (防孤儿烧 token)。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handleRequest } from "../supabase/functions/muse-proxy/router.js";
import { env, getSettings, saveSettings, resolveStaticDir } from "./config.js";
import { discoverSync, refreshPublicIps, createRequestFetcher, type Discovery } from "./egress.js";
import { logRequest } from "./logger.js";
import { verifyPassword, signToken, verifyToken, bearerToken, verifyInternalKey } from "./auth.js";
import { incomingToRequest, respondWithWeb } from "./bridge.js";
import { readLogs } from "./logger.js";

const BOOT_TS = Date.now();

// ---- 发现缓存 (60s 刷新, 公网探测异步补齐) ----
let discovery: Discovery = discoverSync();
let discoveryExp = 0;
function getDiscovery(): Discovery {
  if (Date.now() > discoveryExp) {
    try {
      discovery = discoverSync();
    } catch {
      /* 用旧缓存 */
    }
    discoveryExp = Date.now() + 60_000;
  }
  return discovery;
}
async function kickPublicProbe(): Promise<void> {
  const d = getDiscovery();
  const ips = ["", ...d.secondaries.filter((s) => s.usable).map((s) => s.ip)];
  void refreshPublicIps(ips).then(() => {
    discoveryExp = 0; // 探测完强制刷新一次发现 (带上公网 IP)
  });
}
void kickPublicProbe();
setInterval(() => {
  void kickPublicProbe();
}, 6 * 3600_000).unref();

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  if (first) return first;
  const real = req.headers["x-real-ip"];
  const rip = Array.isArray(real) ? real[0] : real;
  if (rip) return rip;
  return req.socket.remoteAddress ?? "";
}

function readJsonBody(req: http.IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ---- 后台管理 API ----
async function handleAdminApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/admin/api/")) return false;
  const sub = pathname.slice("/admin/api/".length);

  if (sub === "login" && req.method === "POST") {
    try {
      const body = (await readJsonBody(req)) as { password?: string };
      if (typeof body.password === "string" && verifyPassword(body.password)) {
        json(res, 200, { token: signToken() });
      } else {
        json(res, 401, { error: "invalid password" });
      }
    } catch {
      json(res, 400, { error: "invalid JSON" });
    }
    return true;
  }

  // 其余一律鉴权: 内部通道 (网关子系统, x-mp-internal-key) 或
  // 后台 token (Authorization 或 x-admin-key, 直接登录用)。
  let authed = false;
  let viaInternal = false;
  try {
    const headers = new Headers();
    const h = req.headers.authorization;
    if (typeof h === "string") headers.set("authorization", h);
    const ak = req.headers["x-admin-key"];
    headers.set("x-admin-key", Array.isArray(ak) ? ak[0] ?? "" : ak ?? "");
    const ik = req.headers["x-mp-internal-key"];
    headers.set("x-mp-internal-key", Array.isArray(ik) ? ik[0] ?? "" : ik ?? "");
    if (verifyInternalKey(headers)) {
      authed = true;
      viaInternal = true;
    } else {
      authed = verifyToken(bearerToken(headers));
    }
  } catch {
    authed = false;
  }
  if (!authed) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  void viaInternal;

  if (sub === "egress" && req.method === "GET") {
    const settings = getSettings();
    const d = getDiscovery();
    const usable = d.secondaries.filter((s) => s.usable);
    const sel = settings.egress_ips_enabled;
    const enabledSet = new Set(sel.length === 0 ? usable.map((s) => s.ip) : usable.filter((s) => sel.includes(s.ip)).map((s) => s.ip));
    json(res, 200, {
      mode: settings.egress_mode,
      selected: sel,
      default: d.def,
      secondaries: d.secondaries.map((s) => ({ ...s, enabled: enabledSet.has(s.ip) })),
      updated_at: d.updated_at,
    });
    return true;
  }

  if (sub === "egress" && req.method === "PUT") {
    try {
      const body = (await readJsonBody(req)) as { mode?: string; egress_ips_enabled?: string[] };
      if (body.mode !== undefined && body.mode !== "primary" && body.mode !== "secondary") {
        json(res, 400, { error: "invalid mode (primary|secondary)" });
        return true;
      }
      if (body.egress_ips_enabled !== undefined) {
        if (!Array.isArray(body.egress_ips_enabled) || body.egress_ips_enabled.length > 64) {
          json(res, 400, { error: "invalid egress_ips_enabled" });
          return true;
        }
        for (const ip of body.egress_ips_enabled) {
          if (typeof ip !== "string" || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split(".").some((o) => Number(o) > 255)) {
            json(res, 400, { error: `invalid ip: ${JSON.stringify(ip)}` });
            return true;
          }
        }
      }
      const before = getSettings();
      const next = saveSettings({
        ...(body.mode !== undefined ? { egress_mode: body.mode as "primary" | "secondary" } : {}),
        ...(body.egress_ips_enabled !== undefined ? { egress_ips_enabled: body.egress_ips_enabled } : {}),
      });
      // 副模式至少保留一个可用启用 (fail-closed: 校验失败回滚本次写入)。
      if (next.egress_mode === "secondary") {
        const d = getDiscovery();
        const usable = d.secondaries.filter((s) => s.usable);
        const eff = next.egress_ips_enabled.length === 0 ? usable : usable.filter((s) => next.egress_ips_enabled.includes(s.ip));
        if (eff.length === 0) {
          saveSettings(before);
          json(res, 400, { error: "no enabled usable egress IPs (discovery empty or selection excludes all usable)" });
          return true;
        }
      }
      json(res, 200, { ok: true, settings: next });
    } catch {
      json(res, 400, { error: "invalid JSON" });
    }
    return true;
  }

  if (sub === "logs" && req.method === "GET") {
    const u = new URL(req.url ?? "/admin/api/logs", "http://localhost");
    const out = readLogs({
      q: u.searchParams.get("q") ?? undefined,
      limit: Number(u.searchParams.get("limit") ?? 200),
      offset: Number(u.searchParams.get("offset") ?? 0),
    });
    json(res, 200, out);
    return true;
  }

  if (sub === "health" && req.method === "GET") {
    json(res, 200, { ok: true, uptime_s: Math.floor((Date.now() - BOOT_TS) / 1000), mode: getSettings().egress_mode });
    return true;
  }

  json(res, 404, { error: "unknown admin api" });
  return true;
}

// ---- 静态后台 UI ----
const STATIC_DIR = resolveStaticDir();
if (!STATIC_DIR) console.warn("[mp] admin-web dist not found, /admin/* will 404 (run npm run build in admin-web)");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (!pathname.startsWith("/admin/") || pathname.startsWith("/admin/api/")) return false;
  if (!STATIC_DIR) {
    json(res, 404, { error: "admin UI not built" });
    return true;
  }
  let rel = pathname.slice("/admin/".length);
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  // 路径穿越守卫。
  const file = path.normalize(path.join(STATIC_DIR, rel));
  if (!file.startsWith(STATIC_DIR)) {
    json(res, 403, { error: "forbidden" });
    return true;
  }
  let target = file;
  try {
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target = path.join(STATIC_DIR, "index.html");
    const ext = path.extname(target).toLowerCase();
    const body = fs.readFileSync(target);
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
  return true;
}

// ---- 主服务 ----
const server = http.createServer((req, res) => {
  void (async () => {
    const t0 = Date.now();
    const pathname = ((req.url ?? "/").split("?")[0] ?? "/");
    const finish = (status: number, extra: Partial<import("./logger.js").MpLogEntry> = {}) => {
      logRequest({
        time: new Date().toISOString(),
        method: req.method ?? "GET",
        uri: req.url ?? "/",
        status,
        latency_ms: Date.now() - t0,
        client_ip: clientIp(req),
        egress_ip: "",
        egress_name: "",
        egress_public: "",
        upstream_status: null,
        ...extra,
      });
    };

    try {
      // 存活探针 (网关挂载后也可做健康检查)。
      if (pathname === "/mp-healthz" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        finish(200);
        return;
      }
      // 服务自述 (网关剥掉 /mp 后 /mp/ 落到此处)。
      if ((pathname === "/" || pathname === "") && req.method === "GET") {
        json(res, 200, {
          service: "muse-proxy",
          runtime: "local-node",
          endpoints: ["POST /v1/chat/completions", "POST /v1/responses", "POST /v1/messages", "GET /v1/models"],
          admin: "/admin/ (HashRouter) + /admin/api/*",
          egress_mode: getSettings().egress_mode,
        });
        finish(200);
        return;
      }
      if (await handleAdminApi(req, res, pathname)) {
        finish(res.statusCode);
        return;
      }
      if (serveStatic(req, res, pathname)) {
        finish(res.statusCode);
        return;
      }

      // ---- /v1/* 原全部接口 ----
      if (!pathname.startsWith("/v1/")) {
        json(res, 404, { error: `unknown route ${pathname}` });
        finish(404);
        return;
      }
      const settings = getSettings();
      const found = getDiscovery();
      const { fetchImpl, getEgress } = createRequestFetcher(settings.egress_mode, settings.egress_ips_enabled, found);
      const base = `http://${env.bind}:${env.port}`;
      const { request, abort } = incomingToRequest(req, base);
      let finished = false;
      res.on("close", () => {
        if (!finished) {
          finished = true;
          abort(); // 客户端真断开才 abort 上游 (防孤儿烧 token)
        }
      });
      let webRes: Response;
      try {
        webRes = await handleRequest(request, { PROXY_API_KEY: env.proxyApiKey }, { fetchImpl });
      } catch (e) {
        if (!res.writableEnded) json(res, 500, { error: `handler failed: ${(e as Error)?.message ?? e}` });
        finished = true;
        finish(res.statusCode);
        return;
      }
      const eg = getEgress();
      await respondWithWeb(res, webRes);
      finished = true;
      finish(webRes.status, {
        egress_ip: eg ? eg.ip : "",
        egress_name: eg ? eg.name : "",
        egress_public: eg ? eg.public_ip : "",
        upstream_status: webRes.status,
      });
    } catch (e) {
      try {
        if (!res.writableEnded) json(res, 500, { error: `server failed: ${(e as Error)?.message ?? e}` });
      } catch {
        /* ignore */
      }
      finish(res.statusCode || 500);
    }
  })();
});

// SSE 长对话关键: 禁掉总时长掐断 (云函数 300s 上限本机不存在)。
server.requestTimeout = 0;
server.headersTimeout = 120_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

server.listen(env.port, env.bind, () => {
  console.log(`[mp] listening on ${env.bind}:${env.port} (egress discovery: ${getDiscovery().secondaries.length} secondaries)`);
  if (!env.proxyApiKey) console.warn("[mp] PROXY_API_KEY is empty: all /v1/* calls will 401 until configured");
  if (!env.adminPassword) console.warn("[mp] MP_ADMIN_PASSWORD is empty: admin login disabled until configured");
});
