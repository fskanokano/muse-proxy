// Tests for the Anthropic Messages facade (POST /api/messages).
// Covers request lowering + free-tier fingerprint rules, non-streaming
// aggregation, Anthropic SSE raising/framing, and error mapping. The
// upstream is mocked; the chat completions and responses facades have their
// own suites and must remain untouched by these additions.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleMessagesRequest, type MessagesDependencies } from "../api/messages"
import { lowerMessagesRequest } from "../supabase/functions/v1/_lib/messages-lower.ts"
import { MODEL_ID } from "../supabase/functions/v1/_lib/types.ts"
import { OPENCODE_BUILTIN_TOOLS, STUB_BUILTIN_TOOL_DESCRIPTION } from "../supabase/functions/v1/_lib/tools.ts"

const ENV = { PROXY_API_KEY: "test-key" }
const AUTH = { "x-api-key": "test-key" }

type FetchCall = { url: string; init?: RequestInit }

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
  return new Response(lines + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function post(body: unknown) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// lowerMessagesRequest unit tests
// ---------------------------------------------------------------------------

describe("lowerMessagesRequest", () => {
  it("maps a string user message to an input_text item and requires max_tokens", () => {
    const ok = lowerMessagesRequest({ max_tokens: 100, messages: [{ role: "user", content: "hello" }] })
    if ("error" in ok) throw new Error("unexpected error")
    expect(ok.request.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }])
    expect(ok.request.max_output_tokens).toBe(100)
    expect(ok.request.stream).toBe(true)
    expect(ok.request.store).toBe(false)

    // Anthropic spec: max_tokens is required.
    const missing = lowerMessagesRequest({ messages: [{ role: "user", content: "hi" }] })
    expect("error" in missing && missing.error.code === "missing_max_tokens").toBe(true)
  })

  it("accepts role:system/developer messages inside the messages array (Claude Code compat)", () => {
    const result = lowerMessagesRequest({
      max_tokens: 64,
      system: "top-level",
      messages: [
        { role: "system", content: "from-array" },
        { role: "developer", content: [{ type: "text", text: "dev-note" }] },
        { role: "user", content: "hi" },
      ],
    })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.request.input[0]).toEqual({ role: "system", content: "top-level\nfrom-array\ndev-note" })
    expect(result.request.input).toHaveLength(2)
  })

  it("maps system string and text blocks to a leading system item", () => {
    const result = lowerMessagesRequest({
      max_tokens: 64,
      system: [{ type: "text", text: "be terse" }, { type: "text", text: "no emojis" }],
      messages: [{ role: "user", content: "hi" }],
    })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.request.input[0]).toEqual({ role: "system", content: "be terse\nno emojis" })
    expect(result.request.input).toHaveLength(2)
  })

  it("maps user image blocks (base64 and url) to input_image parts", () => {
    const result = lowerMessagesRequest({
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
          ],
        },
      ],
    })
    if ("error" in result) throw new Error("unexpected error")
    const user = result.request.input[0] as { role: string; content: Array<Record<string, string>> }
    expect(user.role).toBe("user")
    expect(user.content).toEqual([
      { type: "input_text", text: "what is this?" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      { type: "input_image", image_url: "https://example.com/cat.png" },
    ])
  })

  it("maps assistant tool_use and user tool_result blocks to function_call/function_call_output items", () => {
    const result = lowerMessagesRequest({
      max_tokens: 64,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "北京" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "晴 26°C" }, { type: "image", source: { type: "url", url: "x" } }],
            },
          ],
        },
      ],
    })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.request.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "weather?" }] },
      { role: "assistant", content: [{ type: "output_text", text: "checking" }] },
      { type: "function_call", call_id: "toolu_1", name: "get_weather", arguments: '{"city":"北京"}' },
      { type: "function_call_output", call_id: "toolu_1", output: "晴 26°C\n{\"type\":\"image\",\"source\":{\"type\":\"url\",\"url\":\"x\"}}" },
    ])
  })

  it("drops thinking blocks on input", () => {
    const result = lowerMessagesRequest({
      max_tokens: 64,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private thoughts", signature: "sig" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "more" },
      ],
    })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.request.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { role: "user", content: [{ type: "input_text", text: "more" }] },
    ])
  })

  it("maps Anthropic tools (input_schema) after the stubbed builtin set and forces tool_choice auto", () => {
    const result = lowerMessagesRequest({
      max_tokens: 64,
      tools: [
        {
          name: "get_weather",
          description: "Query weather",
          input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
        { name: "bash", description: "shadow attempt", input_schema: { type: "object", properties: {} } },
      ],
      messages: [{ role: "user", content: "hi" }],
    })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.request.tool_choice).toBe("auto")
    expect(result.request.tools).toHaveLength(OPENCODE_BUILTIN_TOOLS.length + 1)
    const weather = result.request.tools!.find((tool) => tool.name === "get_weather")!
    expect(weather.parameters).toEqual({ type: "object", properties: { city: { type: "string" } }, required: ["city"] })
    const bash = result.request.tools!.find((tool) => tool.name === "bash")!
    expect(bash.description).toBe("shadow attempt")
  })

  it("maps thinking budget_tokens to the effort whitelist", () => {
    const cases: Array<[unknown, string]> = [
      [{ type: "enabled", budget_tokens: 1024 }, "low"],
      [{ type: "enabled", budget_tokens: 4096 }, "medium"],
      [{ type: "enabled", budget_tokens: 16384 }, "high"],
      [{ type: "enabled", budget_tokens: 32768 }, "xhigh"],
      [{ type: "disabled" }, "none"],
    ]
    for (const [thinking, effort] of cases) {
      const result = lowerMessagesRequest({ max_tokens: 64, thinking, messages: [{ role: "user", content: "hi" }] })
      if ("error" in result) throw new Error("unexpected error")
      expect(result.request.reasoning?.effort).toBe(effort)
    }
    // Absent thinking -> default effort.
    const plain = lowerMessagesRequest({ max_tokens: 64, messages: [{ role: "user", content: "hi" }] })
    if ("error" in plain) throw new Error("unexpected error")
    expect(plain.request.reasoning?.effort).toBeDefined()
  })

  it("clamps max_tokens and passes temperature/top_p", () => {
    const result = lowerMessagesRequest({
      max_tokens: 1_000_000,
      temperature: 0.5,
      top_p: 0.9,
      messages: [{ role: "user", content: "hi" }],
    })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.request.max_output_tokens).toBeLessThanOrEqual(32_000)
    expect(result.request.temperature).toBe(0.5)
    expect(result.request.top_p).toBe(0.9)
  })
})

// ---------------------------------------------------------------------------
// handleMessagesRequest integration tests (mocked upstream)
// ---------------------------------------------------------------------------

describe("messages endpoint integration", () => {
  let calls: FetchCall[] = []
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    calls = []
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockUpstream(responses: Response[]): MessagesDependencies {
    let index = 0
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const response = responses[Math.min(index, responses.length - 1)]!
      index++
      return response
    }) as typeof fetch
    return {}
  }

  it("rejects bad auth, wrong method, and malformed JSON with Anthropic error envelopes", async () => {
    const unauth = await handleMessagesRequest(post({ max_tokens: 8, messages: [{ role: "user", content: "hi" }] }), {
      PROXY_API_KEY: "other-key",
    })
    expect(unauth.status).toBe(401)
    const unauthBody = (await unauth.json()) as { type: string; error: { type: string } }
    expect(unauthBody.type).toBe("error")
    expect(unauthBody.error.type).toBe("authentication_error")

    const get = new Request("http://localhost/v1/messages", { method: "GET", headers: AUTH })
    const methodRes = await handleMessagesRequest(get, ENV)
    expect(methodRes.status).toBe(405)

    const malformed = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: "not json",
    })
    const malformedRes = await handleMessagesRequest(malformed, ENV)
    expect(malformedRes.status).toBe(400)
    const malformedBody = (await malformedRes.json()) as { error: { type: string } }
    expect(malformedBody.error.type).toBe("invalid_request_error")
  })

  it("non-streaming: aggregates text content, stop_reason, and usage; sends the full fingerprint upstream", async () => {
    mockUpstream([
      sseResponse([
        { type: "response.created", response: { id: "resp_up_m1", usage: null } },
        { type: "response.reasoning_summary_text.delta", delta: "pondering" },
        { type: "response.output_text.delta", delta: "Hello " },
        { type: "response.output_text.delta", delta: "there" },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } },
        },
      ]),
    ])

    const res = await handleMessagesRequest(
      post({ model: "claude-3-5-sonnet", max_tokens: 128, messages: [{ role: "user", content: "hi" }] }),
      ENV,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(body.id).toMatch(/^msg_/)
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.model).toBe(MODEL_ID)
    expect(body.stop_reason).toBe("end_turn")
    expect(body.stop_sequence).toBe(null)
    expect(body.content).toEqual([
      { type: "thinking", thinking: "pondering" },
      { type: "text", text: "Hello there" },
    ])
    expect(body.usage).toEqual({ input_tokens: 12, output_tokens: 8 })

    // Upstream fingerprint contract identical to the other facades.
    const headers = (calls[0]!.init!.headers ?? {}) as Record<string, string>
    expect(headers["user-agent"]).toContain("opencode/")
    expect(headers["x-opencode-client"]).toBe("cli")
    const upstreamBody = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>
    expect(upstreamBody.model).toBe(MODEL_ID)
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.store).toBe(false)
    expect(upstreamBody.include).toEqual(["reasoning.encrypted_content"])
    expect(upstreamBody.prompt_cache_key).toBe(headers["x-opencode-session"])
    expect(upstreamBody.tool_choice).toBe("auto")
    expect(upstreamBody.tools as unknown[]).toHaveLength(OPENCODE_BUILTIN_TOOLS.length)
    expect(upstreamBody.max_output_tokens).toBe(128)
  })

  it("non-streaming: tool_use blocks map stop_reason to tool_use", async () => {
    mockUpstream([
      sseResponse([
        { type: "response.output_item.done", item: { type: "function_call", call_id: "call_x", name: "get_weather", arguments: "{\"city\":\"上海\"}" } },
        { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
      ]),
    ])
    const res = await handleMessagesRequest(
      post({
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "get_weather", input_schema: { type: "object", properties: {} } }],
      }),
      ENV,
    )
    const body = (await res.json()) as { content: Array<Record<string, unknown>>; stop_reason: string }
    expect(body.stop_reason).toBe("tool_use")
    expect(body.content).toEqual([{ type: "tool_use", id: "call_x", name: "get_weather", input: { city: "上海" } }])
  })

  it("non-streaming: upstream failure event becomes a 502 Anthropic error", async () => {
    mockUpstream([sseResponse([{ type: "response.failed", response: { error: { code: "provider_error", message: "boom" } } }])])
    const res = await handleMessagesRequest(post({ max_tokens: 8, messages: [{ role: "user", content: "hi" }] }), ENV)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { type: string; error: { type: string; message: string } }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("api_error")
    expect(body.error.message).toBe("boom")
  })

  it("non-streaming: upstream EOF without a terminal event returns 502", async () => {
    mockUpstream([sseResponse([{ type: "response.output_text.delta", delta: "partial" }])])
    const res = await handleMessagesRequest(post({ max_tokens: 8, messages: [{ role: "user", content: "hi" }] }), ENV)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("terminal response event")
  })

  it("streaming: emits the canonical Anthropic event sequence with event:/data: framing and no [DONE]", async () => {
    mockUpstream([
      sseResponse([
        { type: "response.created", response: { id: "resp_s_m1" } },
        { type: "response.reasoning_summary_text.delta", delta: "hmm " },
        { type: "response.output_text.delta", delta: "He" },
        { type: "response.output_text.delta", delta: "llo" },
        { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2 } } },
        { type: "ping" },
      ]),
    ])

    const res = await handleMessagesRequest(post({ max_tokens: 64, messages: [{ role: "user", content: "hi" }], stream: true }), ENV)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const text = await res.text()
    expect(text).not.toContain("[DONE]")
    expect(text).not.toContain("ping")

    const frames = text.split("\n\n").filter((block) => block.startsWith("event: "))
    const types = frames.map((frame) => frame.split("\n")[0]!.slice("event: ".length))
    expect(types).toEqual([
      "message_start",
      "content_block_start", // thinking
      "content_block_delta",
      "content_block_stop",
      "content_block_start", // text
      "content_block_delta", // He
      "content_block_delta", // llo
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])

    const start = JSON.parse(frames[0]!.split("\n")[1]!.slice("data: ".length)) as { message: Record<string, unknown> }
    expect(start.message.role).toBe("assistant")
    expect(start.message.type).toBe("message")

    const delta = JSON.parse(frames[5]!.split("\n")[1]!.slice("data: ".length)) as {
      index: number
      delta: { type: string; text: string }
    }
    expect(delta.index).toBe(1)
    expect(delta.delta).toEqual({ type: "text_delta", text: "He" })

    const messageDelta = JSON.parse(frames.at(-2)!.split("\n")[1]!.slice("data: ".length)) as {
      delta: { stop_reason: string }
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(messageDelta.delta.stop_reason).toBe("end_turn")
    expect(messageDelta.usage).toEqual({ input_tokens: 3, output_tokens: 2 })

    expect(types.at(-1)).toBe("message_stop")
  })

  it("streaming: tool calls surface as tool_use blocks with input_json_delta", async () => {
    mockUpstream([
      sseResponse([
        { type: "response.output_text.delta", delta: "Let me check." },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "call_y", name: "get_weather", arguments: "{\"city\":\"上海\"}" } },
        { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 7 } } },
      ]),
    ])
    const res = await handleMessagesRequest(post({ max_tokens: 64, messages: [{ role: "user", content: "hi" }], stream: true }), ENV)
    const text = await res.text()
    expect(text).toContain('"tool_use"')
    expect(text).toContain('"input_json_delta"')
    expect(text).toContain('\\"city\\":\\"上海\\"')
    const messageDelta = text
      .split("\n\n")
      .filter((block) => block.startsWith("event: message_delta"))
      .map((block) => JSON.parse(block.split("\n")[1]!.slice("data: ".length)) as { delta: { stop_reason: string } })
      .at(0)
    expect(messageDelta?.delta.stop_reason).toBe("tool_use")
  })

  it("streaming: upstream EOF without a terminal event surfaces an Anthropic error event", async () => {
    mockUpstream([sseResponse([{ type: "response.output_text.delta", delta: "truncat" }])])
    const res = await handleMessagesRequest(post({ max_tokens: 64, messages: [{ role: "user", content: "hi" }], stream: true }), ENV)
    const text = await res.text()
    expect(text).toContain("upstream_stream_truncated")
    const types = text
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((frame) => frame.split("\n")[0]!.slice("event: ".length))
    expect(types.at(-1)).toBe("error")
  })

  it("maps upstream 429 to a 429 Anthropic rate_limit_error", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), { status: 429 })) as typeof fetch
    const res = await handleMessagesRequest(post({ max_tokens: 8, messages: [{ role: "user", content: "hi" }] }), ENV)
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("rate_limit_error")
  })

  it("propagates multi-turn replay items to the upstream body in order", async () => {
    mockUpstream([sseResponse([{ type: "response.completed", response: {} }])])
    await handleMessagesRequest(
      post({
        max_tokens: 64,
        system: "be terse",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
          { role: "user", content: "more" },
        ],
      }),
      ENV,
    )
    const body = JSON.parse(String(calls[0]!.init!.body)) as { input: Array<Record<string, unknown>> }
    const kinds = body.input.map((item) => ("role" in item ? item.role : item.type))
    expect(kinds).toEqual(["system", "user", "assistant", "user"])
    expect(body.input[0]).toEqual({ role: "system", content: "be terse" })
  })
})
