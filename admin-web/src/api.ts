/** API 客户端: 相对路径 (经网关 /mp 挂载与直连两种形态都成立)。 */
const TOKEN_KEY = "mp_token";
const GW_KEY = "mp_gw_key";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}
export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}
/** 网关边缘钥 (经网关挂载访问时放 Authorization, 直连时可空)。 */
export function getGwKey(): string {
  try {
    return localStorage.getItem(GW_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setGwKey(k: string) {
  try {
    if (k) localStorage.setItem(GW_KEY, k);
    else localStorage.removeItem(GW_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as object) };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  // 后台 token 走 x-admin-key (Authorization 要让给网关边缘钥);
  // 直连时 Authorization 兜底同样带上, 服务端任一认可。
  if (token) headers["x-admin-key"] = token;
  headers.Authorization = `Bearer ${getGwKey() || token || ""}`;
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, "网络失败，请检查连接后重试");
  }
  if (res.status === 401) {
    clearToken();
    if (!location.hash.includes("/login")) location.hash = "#/login";
    throw new ApiError(401, "未授权，请重新登录");
  }
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "";
    throw new ApiError(res.status, raw || `请求失败 (${res.status})`);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) => request<T>(p, { method: "POST", body: JSON.stringify(body ?? {}) }),
  put: <T>(p: string, body?: unknown) => request<T>(p, { method: "PUT", body: JSON.stringify(body ?? {}) }),
};

export interface EgressSecondary {
  ip: string;
  name: string;
  public_ip: string;
  usable: boolean;
  enabled: boolean;
}

export interface EgressStatus {
  mode: "primary" | "secondary";
  selected: string[];
  default: { ip: string; name: string; public_ip: string } | null;
  secondaries: EgressSecondary[];
  updated_at: number;
}

export interface MpLogItem {
  time: string;
  method: string;
  uri: string;
  status: number;
  latency_ms: number;
  client_ip: string;
  egress_ip: string;
  egress_name: string;
  egress_public: string;
  upstream_status: number | null;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString("zh-CN", { hour12: false });
}
