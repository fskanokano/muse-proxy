import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleChatRequest } from "../api/chat"

const ENV = { PROXY_API_KEY: "test-key" }

function postRequest(body: unknown, headers: Record<string, string> = { authorization: "Bearer test-key" }) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
  return new Response(lines + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

type FetchCall = { url: string; init?: RequestInit }

describe("handleChatRequest", () => {
  let calls: FetchCall[] = []
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    calls = []
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(response: Response) {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return response
    }) as typeof fetch
  }

  async function readSse(res: Response): Promise<{ chunks: Array<Record<string, unknown>>; raw: string }> {
    const text = await res.text()
    const chunks: Array<Record<string, unknown>> = []
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const data = trimmed.slice(5).trim()
      if (data === "[DONE]") continue
      chunks.push(JSON.parse(data))
    }
    return { chunks, raw: text }
  }

  it("returns 401 without auth", async () => {
    mockFetch(sseResponse([]))
    const res = await handleChatRequest(postRequest({ messages: [] }, {}), ENV)
    expect(res.status).toBe(401)
  })

  it("returns 400 on invalid body", async () => {
    mockFetch(sseResponse([]))
    const res = await handleChatRequest(postRequest({ messages: "bad" }), ENV)
    expect(res.status).toBe(400)
  })

  it("maps upstream 429 to 429", async () => {
    mockFetch(new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 }))
    const res = await handleChatRequest(postRequest({ messages: [{ role: "user", content: "hi" }] }), ENV)
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("upstream_rate_limited")
  })

  it("maps upstream 500 to 502", async () => {
    mockFetch(new Response("boom", { status: 500 }))
    const res = await handleChatRequest(postRequest({ messages: [{ role: "user", content: "hi" }] }), ENV)
    expect(res.status).toBe(502)
  })

  it("streams chat chunks with heartbeats preserved and [DONE] terminator", async () => {
    mockFetch(
      sseResponse([
        { type: "response.output_text.delta", delta: "he" },
        { type: "response.output_text.delta", delta: "llo" },
        {
          type: "response.completed",
          response: { id: "resp_x", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
        },
      ]),
    )
    const res = await handleChatRequest(
      postRequest({ messages: [{ role: "user", content: "hi" }], stream: true }),
      ENV,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(res.headers.get("x-accel-buffering")).toBe("no")

    const { chunks, raw } = await readSse(res)
    expect(raw.endsWith("data: [DONE]\n\n")).toBe(true)
    const contents = chunks
      .map((c) => (c as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content)
      .filter(Boolean)
    expect(contents.join("")).toBe("hello")
    const finish = chunks.find((c) => (c as { choices?: Array<{ finish_reason?: string }> }).choices?.[0]?.finish_reason)
    expect(finish && (finish as { choices: Array<{ finish_reason: string }> }).choices[0]!.finish_reason).toBe("stop")
    expect((finish as { usage?: { total_tokens: number } }).usage?.total_tokens).toBe(5)
  })

  it("sends the lowered request upstream with muse-specific options", async () => {
    mockFetch(sseResponse([{ type: "response.completed", response: {} }]))
    await handleChatRequest(
      postRequest({ messages: [{ role: "user", content: "hi" }], max_tokens: 1000 }),
      ENV,
    )
    expect(calls).toHaveLength(1)
    const init = calls[0]!.init!
    expect(calls[0]!.url).toBe("https://opencode.ai/zen/v1/responses")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer public")
    const body = JSON.parse(String(init.body)) as {
      store: boolean
      include: string[]
      reasoning: { effort: string; summary: string }
      max_output_tokens: number
      stream: boolean
    }
    expect(body.store).toBe(false)
    expect(body.include).toEqual(["reasoning.encrypted_content"])
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" })
    expect(body.max_output_tokens).toBe(1000)
    expect(body.stream).toBe(true)
  })

  it("aggregates a non-streaming completion", async () => {
    mockFetch(
      sseResponse([
        { type: "response.reasoning_summary_text.delta", delta: "think" },
        { type: "response.output_text.delta", delta: "ans" },
        { type: "response.output_text.delta", delta: "wer" },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } },
        },
      ]),
    )
    const res = await handleChatRequest(
      postRequest({ messages: [{ role: "user", content: "hi" }], stream: false }),
      ENV,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      choices: Array<{ message: { role: string; content: string; reasoning_content?: string }; finish_reason: string }>
      usage: { total_tokens: number }
    }
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0]!.message.content).toBe("answer")
    expect(body.choices[0]!.message.reasoning_content).toBe("think")
    expect(body.choices[0]!.finish_reason).toBe("stop")
    expect(body.usage.total_tokens).toBe(12)
  })

  it("aggregates tool calls in a non-streaming completion", async () => {
    mockFetch(
      sseResponse([
        {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "call_9", name: "echo", arguments: "{\"a\":1}" },
        },
        { type: "response.completed", response: {} },
      ]),
    )
    const res = await handleChatRequest(
      postRequest({ messages: [{ role: "user", content: "hi" }], stream: false }),
      ENV,
    )
    const body = (await res.json()) as {
      choices: Array<{ message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason: string }>
    }
    expect(body.choices[0]!.message.tool_calls).toEqual([
      { id: "call_9", type: "function", function: { name: "echo", arguments: "{\"a\":1}" } },
    ])
    expect(body.choices[0]!.finish_reason).toBe("tool_calls")
  })
})
