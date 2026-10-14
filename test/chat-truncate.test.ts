// chat 非流式截断守卫集成测试: 上游半路 EOF (无终端事件) 必须 502,
// 不能把半截内容当完整答案 200 回去 (stub fetch, 不碰真上游)。
import { describe, expect, it } from "vitest"
import { handleChatRequest } from "../api/chat"

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
}

function stubFetch(frames: string[]): typeof fetch {
  return (async () =>
    new Response(sseStream(frames), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch
}

const BODY = {
  model: "muse-spark-1.3-contributor-free",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
}

function req(): Request {
  return new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify(BODY),
  })
}

describe("chat non-stream truncation guard", () => {
  it("upstream EOF without terminal event -> 502 upstream_stream_truncated", async () => {
    const res = await handleChatRequest(req(), { PROXY_API_KEY: "test-key" }, {
      fetchImpl: stubFetch([`data: {"type":"response.output_text.delta","delta":"half"}\n\n`]),
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("upstream_stream_truncated")
  })

  it("normal completed stream still aggregates 200", async () => {
    const res = await handleChatRequest(req(), { PROXY_API_KEY: "test-key" }, {
      fetchImpl: stubFetch([
        `data: {"type":"response.output_text.delta","delta":"full"}\n\n`,
        `data: {"type":"response.completed","response":{"usage":null}}\n\n`,
      ]),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]!.message.content).toBe("full")
  })
})
