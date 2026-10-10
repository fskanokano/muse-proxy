// Node http <-> Web fetch 桥接 (SSE 长连接安全)。
//
// 下行 (回客户端): 状态头立即 flush, 体逐块透传, 零缓冲、零总时长限制。
// 上行 (到 handler): 客户端提前断开才 abort 上游; 正常收完请求体后的
// req 'close' 不是断开, 绝不能 abort (否则 GET/小 POST 恒被误杀)。
import type { IncomingMessage, ServerResponse } from "node:http";

/** node req -> Web Request (baseUrl 仅供构造完整 URL, 如 http://127.0.0.1:18091)。 */
export function incomingToRequest(req: IncomingMessage, baseUrl: string): { request: Request; abort: () => void } {
  const url = `${baseUrl.replace(/\/$/, "")}${req.url ?? "/"}`;
  const ctrl = new AbortController();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.append(k, v);
    }
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(url, {
    method: req.method ?? "GET",
    headers,
    // node req 是 async iterable, 直接作为 web body (要求 duplex: half)。
    body: hasBody ? (req as unknown as BodyInit) : undefined,
    duplex: "half",
    signal: ctrl.signal,
  } as RequestInit);
  // 仅"响应尚未完成时的连接断开"才 abort (上传中/等上游/下行中任一阶段真断开)。
  // res 由调用方传入? 此处只管 req 侧: req aborted(上传中断) -> abort。
  req.on("aborted", () => {
    try {
      ctrl.abort();
    } catch {
      /* ignore */
    }
  });
  return {
    request,
    abort: () => {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Web Response -> node res (头即时 flush, 体流式透传)。 */
export async function respondWithWeb(nodeRes: ServerResponse, webRes: Response): Promise<void> {
  const outHeaders: Record<string, string | string[]> = {};
  webRes.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    // 逐跳头绝不过界 (node 自己管理成块/连接)。
    if (lk === "content-length" || lk === "transfer-encoding" || lk === "connection" || lk === "keep-alive") return;
    outHeaders[k] = v;
  });
  // SSE 关键头兜底 (handler 本来就会带, 双保险)。
  const ct = webRes.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    outHeaders["cache-control"] ??= "no-cache, no-transform";
    outHeaders["x-accel-buffering"] ??= "no";
  }
  nodeRes.writeHead(webRes.status, outHeaders);
  // 立即 flush 头 (首字延迟关键; 长推理静默期靠心跳 + 无总超时维持)。
  try {
    (nodeRes as unknown as { flushHeaders?: () => void }).flushHeaders?.();
  } catch {
    /* ignore */
  }
  if (webRes.body === null) {
    nodeRes.end();
    return;
  }
  const reader = webRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (nodeRes.destroyed || nodeRes.writableEnded) break;
      const ok = nodeRes.write(value);
      if (!ok) await new Promise<void>((r) => nodeRes.once("drain", () => r()));
    }
  } catch {
    /* 上下游任一中断即收尾 */
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
    if (!nodeRes.writableEnded) {
      try {
        nodeRes.end();
      } catch {
        /* ignore */
      }
    }
  }
}
