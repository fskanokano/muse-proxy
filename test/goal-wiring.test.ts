// goal 接线集成测试 (chat 门面, stub fetchImpl):
// 首轮无工具干净收尾 -> judge CONTINUE -> 自动续轮 -> 工具出现, 全程一个终端。
// muse 上游退役后走 oa-compat 上游; judge/续轮都 stream:true, 以消息形状区分。
import { describe, expect, it } from "vitest";
import { handleChatRequest } from "../supabase/functions/muse-proxy/chat.ts";

const GOAL = "muse-spark-1.3-contributor-goal";
const WIRE_MODEL = "deepseek-v4.1-flash-free";

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

function judgeStream(text: string): Response {
  return sse([`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`, `data: [DONE]\n\n`]);
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
    const posts: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { messages?: Array<{ role: string; content?: string }>; model?: string };
      const messages = body.messages ?? [];
      const isJudge = messages[0]?.role === "system"; // judge 注入 system; 续轮/首轮以 client 文案开头
      posts.push({ isJudge, model: body.model, nMessages: messages.length });
      if (isJudge) return judgeStream("CONTINUE because no search yet, call web_search next");
      const streams = posts.filter((p) => !p.isJudge).length;
      if (streams === 1) {
        // 首轮: 纯文本干净收尾
        return sse([
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "working on it" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          `data: [DONE]\n\n`,
        ]);
      }
      // 续轮: 工具调用干净收尾; 上游模型 id 必须是别名 wire id (goal id 只对客户端)
      return sse([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: "{}" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        `data: [DONE]\n\n`,
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
    // 上游调用序列: 首轮 stream + judge stream + 续轮 stream, 上游模型恒为 wire 别名
    expect(posts).toHaveLength(3);
    expect(posts.every((p) => p.model === WIRE_MODEL)).toBe(true);
  });

  it("goal 模型回显 goal id (非 wire 别名 id)", async () => {
    const fetchImpl = (async () =>
      sse([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        `data: [DONE]\n\n`,
      ])) as typeof fetch;
    const res = await handleChatRequest(req(), { PROXY_API_KEY: "k", goalMaxRounds: 2 }, { fetchImpl });
    const text = await res.text();
    expect(text).toContain(GOAL);
    expect(text).not.toContain(WIRE_MODEL);
  });
});
