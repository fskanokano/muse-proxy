// fetch 兼容的上游请求层 (node:http/https 自研, 替代 undici)。
//
// 为什么不用 undici: 实测 `new Agent({ connect: { localAddress } })`
// 绑定不生效 (不同源 IP 全部走默认路由出去), 而 node:http 的
// per-request `localAddress` 经 egress-router 已验证可靠。
// keep-alive 池必须按出口 IP 隔离 (混用会把绑定 A 的复用连接错用于 B)。
//
// 接口与全局 fetch 对齐到各门面实际用到的子集:
// 输入 string URL + init {method/headers/body/signal}, 输出标准 Response
// (status/headers/body 流式, .json()/.text() 照常)。上游证书默认校验
// (与全局 fetch 一致; 本机直连 opencode.ai 公网, 证书合法)。

import http from "node:http";
import https from "node:https";

type FetchFn = typeof fetch;

function toNodeHeaders(h: HeadersInit | undefined): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!h) return out;
  const src = new Headers(h as HeadersInit);
  src.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === "connection" || lk === "keep-alive" || lk === "transfer-encoding" || lk === "content-length" || lk === "host") return;
    const prev = out[lk];
    if (prev === undefined) out[lk] = v;
    else if (Array.isArray(prev)) prev.push(v);
    else out[lk] = [prev, v];
  });
  return out;
}

async function writeBody(nodeReq: http.ClientRequest, body: BodyInit | null | undefined): Promise<void> {
  if (body === null || body === undefined) {
    nodeReq.end();
    return;
  }
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    nodeReq.end(body as unknown as Uint8Array);
    return;
  }
  // Web ReadableStream (各门面实际只发 JSON 字符串, 此分支兜底)。
  const stream = body as unknown as AsyncIterable<Uint8Array>;
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    try {
      for await (const chunk of stream) {
        if (nodeReq.destroyed) return;
        const ok = nodeReq.write(chunk);
        if (!ok) await new Promise<void>((r) => nodeReq.once("drain", () => r()));
      }
      nodeReq.end();
    } catch {
      try {
        nodeReq.destroy();
      } catch {
        /* ignore */
      }
    }
    return;
  }
  nodeReq.end();
}

// `${proto}:${egress ?? "default"}` -> keep-alive Agent (按出口隔离)。
const pools = new Map<string, http.Agent | https.Agent>();
function agentFor(protocol: string, egressIp?: string): http.Agent | https.Agent {
  const key = `${protocol}:${egressIp ?? "default"}`;
  let a = pools.get(key);
  if (!a) {
    const opts = { keepAlive: true, maxSockets: 128, keepAliveMsecs: 75000, timeout: 8000 };
    a = protocol === "https:" ? new https.Agent(opts) : new http.Agent(opts);
    pools.set(key, a);
  }
  return a;
}

export function nodeHttpFetch(input: string, init: RequestInit = {}, egressIp?: string): Promise<Response> {
  const url = new URL(input);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = toNodeHeaders(init.headers);
  const mod = url.protocol === "https:" ? https : http;
  const signal = init.signal as AbortSignal | undefined;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    let nodeReq: http.ClientRequest;
    try {
      nodeReq = mod.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          agent: agentFor(url.protocol, egressIp),
          ...(egressIp ? { localAddress: egressIp } : {}),
        },
        (upRes) => {
          const outHeaders = new Headers();
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              for (const item of v) outHeaders.append(k, item);
            } else {
              outHeaders.append(k, v);
            }
          }
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              upRes.on("data", (c: Buffer) => {
                try {
                  controller.enqueue(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
                } catch {
                  /* 控制器已关 */
                }
              });
              upRes.on("end", () => {
                try {
                  controller.close();
                } catch {
                  /* ignore */
                }
              });
              upRes.on("error", (e) => {
                try {
                  controller.error(e);
                } catch {
                  /* ignore */
                }
              });
            },
            cancel() {
              try {
                upRes.destroy();
              } catch {
                /* ignore */
              }
            },
          });
          done(() =>
            resolve(
              new Response(stream, {
                status: upRes.statusCode ?? 502,
                statusText: upRes.statusMessage ?? "",
                headers: outHeaders,
              }),
            ),
          );
        },
      );
    } catch (e) {
      done(() => reject(e));
      return;
    }

    // 仅建连阶段 10s 超时 (握手完成后取消; 长 SSE 由调用方守护, 此处不限总时长)。
    nodeReq.on("socket", (sock: import("node:net").Socket) => {
      try {
        if (!sock.connecting) return;
        const timer = setTimeout(() => {
          done(() => reject(new Error("upstream connect timeout")));
          try {
            nodeReq.destroy();
          } catch {
            /* ignore */
          }
        }, 10000);
        timer.unref?.();
        const clear = () => clearTimeout(timer);
        sock.once("connect", clear);
        sock.once("secureConnect", clear);
      } catch {
        /* ignore */
      }
    });
    nodeReq.on("timeout", () => {
      done(() => reject(new Error("upstream socket timeout")));
      try {
        nodeReq.destroy();
      } catch {
        /* ignore */
      }
    });
    nodeReq.on("error", (e) => done(() => reject(e)));

    if (signal) {
      if (signal.aborted) {
        try {
          nodeReq.destroy();
        } catch {
          /* ignore */
        }
        done(() => reject(new DOMException("aborted", "AbortError")));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          try {
            nodeReq.destroy();
          } catch {
            /* ignore */
          }
          done(() => reject(new DOMException("aborted", "AbortError")));
        },
        { once: true },
      );
    }

    void writeBody(nodeReq, init.body as BodyInit | undefined).catch((e) => done(() => reject(e)));
  });
}

/** 绑定指定出口的 fetchImpl (egressIp 缺席 = 默认路由, 与全局 fetch 等价)。 */
export function fetchWithEgress(egressIp?: string): FetchFn {
  return ((input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const merged: RequestInit = { ...init };
    if (typeof input !== "string" && !(input instanceof URL)) {
      try {
        const r = input as Request;
        merged.method = init.method ?? r.method;
        if (!init.headers) merged.headers = r.headers;
        if (init.body === undefined && init.method !== undefined && init.method !== "GET" && init.method !== "HEAD") {
          merged.body = r.body as BodyInit | undefined;
          (merged as Record<string, unknown>).duplex = "half";
        }
      } catch {
        /* 退化为 init */
      }
    }
    return nodeHttpFetch(url, merged, egressIp);
  }) as FetchFn;
}
