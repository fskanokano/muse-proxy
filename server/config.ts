// 本地服务配置: 环境变量 + JSON 设置持久化 (data/mp-settings.json)。
import fs from "node:fs";
import path from "node:path";

export const env = {
  port: Number(process.env.MP_PORT || "18091"),
  bind: process.env.MP_BIND || "127.0.0.1",
  /** 客户端访问本服务的 API key (透传给各门面的 PROXY_API_KEY 校验)。 */
  proxyApiKey: process.env.PROXY_API_KEY || "",
  /** 后台管理员密码 (登录用, 必填)。 */
  adminPassword: process.env.MP_ADMIN_PASSWORD || "",
  dataDir: process.env.MP_DATA_DIR || path.resolve(process.cwd(), "data"),
  /** 管理后台静态目录 (admin-web 构建产物; 为空则自动探测)。 */
  staticDirOverride: process.env.MP_STATIC_DIR || "",
};

if (!Number.isInteger(env.port) || env.port < 1 || env.port > 65535) {
  throw new Error(`[mp] invalid MP_PORT=${JSON.stringify(process.env.MP_PORT ?? "")}`);
}

export interface MpSettings {
  egress_mode: "primary" | "secondary";
  /** 启用的副出口 IP 列表; 空数组 = 默认勾选全部可用副出口。 */
  egress_ips_enabled: string[];
}

const DEFAULTS: MpSettings = { egress_mode: "primary", egress_ips_enabled: [] };

function settingsFile(): string {
  return path.join(env.dataDir, "mp-settings.json");
}

export function getSettings(): MpSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Partial<MpSettings>;
    const mode = raw.egress_mode === "secondary" ? "secondary" : "primary";
    const list = Array.isArray(raw.egress_ips_enabled) ? raw.egress_ips_enabled.filter((s) => typeof s === "string") : [];
    return { egress_mode: mode, egress_ips_enabled: list };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch: Partial<MpSettings>): MpSettings {
  const cur = getSettings();
  const next: MpSettings = {
    egress_mode: patch.egress_mode === "secondary" ? "secondary" : patch.egress_mode === "primary" ? "primary" : cur.egress_mode,
    egress_ips_enabled: Array.isArray(patch.egress_ips_enabled) ? patch.egress_ips_enabled : cur.egress_ips_enabled,
  };
  fs.mkdirSync(env.dataDir, { recursive: true });
  const tmp = `${settingsFile()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, settingsFile());
  return next;
}

export function accessLogFile(): string {
  return path.join(env.dataDir, "mp-access.jsonl");
}

/** 管理后台静态目录候选 (构建产物优先, 源码 dist 次之)。 */
export function resolveStaticDir(): string | null {
  const cands = [
    env.staticDirOverride,
    path.join(process.cwd(), "admin-web", "dist"),
    path.resolve(process.cwd(), "../admin-web/dist"),
  ].filter(Boolean) as string[];
  for (const d of cands) {
    try {
      if (fs.existsSync(path.join(d, "index.html"))) return d;
    } catch {
      /* ignore */
    }
  }
  return null;
}
