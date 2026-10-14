// goal 接线集成测试 (chat 门面, stub fetchImpl):
// 首轮无工具干净收尾 -> judge CONTINUE -> 自动续轮 -> 工具出现, 全程一个终端。
import { describe, expect, it } from "vitest";
import { handleChatRequest } from "../supabase/functions/muse-proxy/chat.ts";

const GOAL = "muse-spark-1.3-contributor-goal";

function sse(frames: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function judgeJson(text: string): Response {
  return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function req(): Request {
  return new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify({
      model: GOAL,
      messages: [{ role: "user", content: "search oracle pricing" }],
      tools: [{ type: "function", function: { name: "web_search", description: "s", parameters: { type: "object" } } }],
      stream: true,
    }),
  });
}

describe("goal wiring (chat facade)", () => {
  it("text-only 首轮 -> judge CONTINUE -> 续轮出工具, 终端唯一", async () => {
    const posts: unknown[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { stream?: boolean; input?: unknown[]; model?: string };
      posts.push({ stream: body.stream, items: Array.isArray(body.input) ? body.input.length : -1, model: body.model });
      if (body.stream === false) return judgeJson("CONTINUE because no search yet, call web_search next");
      const n = posts.filter((p) => (p as { stream?: boolean }).stream !== false).length;
      if (n === 1) {
        // 首轮: 纯文本干净收尾
        return sse([
          `data: {"type":"response.output_text.delta","delta":"working on it"}\n\n`,
          `data: {"type":"response.completed","response":{"usage":null}}\n\n`,
        ]);
      }
      // 续轮: 工具调用干净收尾; 上游模型 id 必须是 muse (goal id 只对客户端)
      return sse([
        `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1","name":"web_search","arguments":"{}"}}\n\n`,
        `data: {"type":"response.completed","response":{"usage":null}}\n\n`,
      ]);
    }) as typeof fetch;

    const res = await handleChatRequest(req(), { PROXY_API_KEY: "k", goalMaxRounds: 2 }, { fetchImpl });
    expect(res.status).toBe(200);
    const text = await res.text();
    // 续轮工具出现, 且只有一个 finish (tool_calls, 不是 stop)
    expect(text).toContain("web_search");
    const finishes = [...text.matchAll(/"finish_reason":"([^"]+)"/g)].map((m) => m[1]);
    expect(finishes).toEqual(["tool_calls"]);
    expect(text).toContain("data: [DONE]");
    // 上游调用序列: 首轮 stream + judge + 续轮 stream, 且上游模型恒为 muse
    expect(posts).toHaveLength(3);
    expect(posts.every((p) => (p as { model?: string }).model === "muse-spark-1.3-contributor-free")).toBe(true);
  });

  it("goal 模型回显 goal id (非 muse id)", async () => {
    const fetchImpl = (async () =>
      sse([`data: {"type":"response.completed","response":{"usage":null}}\n\n`])) as typeof fetch;
    const res = await handleChatRequest(req(), { PROXY_API_KEY: "k", goalMaxRounds: 2 }, { fetchImpl });
    const text = await res.text();
    expect(text).toContain(GOAL);
  });
});
