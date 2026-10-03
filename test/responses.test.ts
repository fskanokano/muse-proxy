// Tests for the OpenAI Responses facade (POST /api/responses).
// Covers request normalization + free-tier fingerprint rules, non-streaming
// aggregation, SSE passthrough framing, and error mapping. The upstream is
// mocked; the chat completions facade has its own suites and must remain
// untouched by these additions.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleResponsesRequest, type ResponsesDependencies } from "../api/responses"
import { normalizeResponsesRequest } from "../supabase/functions/v1/_lib/responses-lower.ts"
import { MODEL_ID } from "../supabase/functions/v1/_lib/types.ts"
import { OPENCODE_BUILTIN_TOOLS, STUB_BUILTIN_TOOL_DESCRIPTION } from "../supabase/functions/v1/_lib/tools.ts"

const ENV = { PROXY_API_KEY: "test-key" }
const AUTH = { authorization: "Bearer test-key" }

type FetchCall = { url: string; init?: RequestInit }

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
  return new Response(lines + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function post(body: unknown) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// normalizeResponsesRequest unit tests
// ---------------------------------------------------------------------------

describe("normalizeResponsesRequest", () => {
  it("maps a string input to a user input_text item", () => {
    const result = normalizeResponsesRequest({ input: "hello" })
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.stream).toBe(false)
    expect(result.request.model).toBe(MODEL_ID)
    expect(result.request.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }])
    expect(result.request.store).toBe(false)
    expect(result.request.include).toEqual(["reasoning.encrypted_content"])
    expect(result.request.reasoning).toEqual({ effort: "high", summary: "auto" })
  })

  it("honors stream:true and returns the stream flag", () => {
    const result = normalizeResponsesRequest({ input: "hi", stream: true })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.stream).toBe(true)
    // The upstream request is always stream:true internally.
    expect(result.request.stream).toBe(true)
  })

  it("prepends instructions as a system message", () => {
    const result = normalizeResponsesRequest({ input: "hi", instructions: "be terse" })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.request.input[0]).toEqual({ role: "system", content: "be terse" })
    expect(result.request.input[1]).toEqual({ role: "user", content: [{ type: "input_text", text: "hi" }] })
  })

  it("normalizes message items with user parts, assistant output_text, and system parts", () => {
    const result = normalizeResponsesRequest({
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "sys" }] },
        { role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "prior answer" }] },
      ],
    })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.request.input).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] },
      { role: "assistant", content: [{ type: "output_text", text: "prior answer" }] },
    ])
  })

  it("passes function_call / function_call_output items through", () => {
    const result = normalizeResponsesRequest({
      input: [
        { type: "function_call", call_id: "call_1", name: "echo", arguments: '{"x":1}' },
        { type: "function_call_output", call_id: "call_1", output: "done" },
      ],
    })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.request.input).toEqual([
      { type: "function_call", call_id: "call_1", name: "echo", arguments: '{"x":1}' },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ])
  })

  it("unwraps namespace tools and strips dotted call names for upstream", () => {
    const result = normalizeResponsesRequest({
      input: "hi",
      tools: [
        {
          type: "namespace",
          name: "muse",
          description: "Muse Code tool set.",
          tools: [
            { type: "function", name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
          ],
        },
      ],
    })
    if ("error" in result) throw new Error("unexpected error")
    const names = (result.request.tools ?? []).map((tool) => tool.name)
    expect(names).toContain("read_file")
    expect(result.clientToolNames.has("read_file")).toBe(true)
    expect(result.nsPrefixByBare.get("read_file")).toBe("muse")

    const replay = normalizeResponsesRequest({
      input: [
        { type: "function_call", call_id: "c1", name: "muse.muse__read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    })
    if ("error" in replay) throw new Error("unexpected error")
    expect(replay.request.input).toEqual([
      { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ])
  })
  it("rewrites codex custom exec tools to upstream functions with trimmed descriptions", () => {
    const longDescription = `${"Run JavaScript code to orchestrate tool calls. "}\n\n${"x".repeat(20_000)}`
    const result = normalizeResponsesRequest({
      input: "hi",
      tools: [
        { type: "custom", name: "exec", description: longDescription, format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" } },
        { type: "web_search", external_web_access: true },
      ],
    })
    if ("error" in result) throw new Error("unexpected error")
    // custom/exec 转写为 function 上行（上游拒收 type=custom），无名 web_search 仍忽略。
    expect(result.clientToolNames.has("exec")).toBe(true)
    const sent = result.request.tools!.find((tool) => tool.name === "exec")!
    expect(sent.type).toBe("function")
    expect(sent.description.length).toBeLessThanOrEqual(2000)
    expect(sent.parameters).toEqual({
      type: "object",
      properties: { input: { type: "string", description: "Raw JavaScript source text orchestrating nested tool calls (native exec payload key)" } },
      required: ["input"],
    })
    expect(result.request.tools!.every((tool) => tool.type === "function")).toBe(true)
  })


  it("tracks rewritten custom tools and accepts custom_tool_call_output replay", () => {
    const result = normalizeResponsesRequest({
      input: "hi",
      tools: [{ type: "custom", name: "exec", description: "Run JS.", format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" } }],
    })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.customToolNames.has("exec")).toBe(true)
    const replay = normalizeResponsesRequest({
      input: [
        { type: "function_call", call_id: "c1", name: "exec", arguments: '{"input":"1+1"}' },
        { type: "custom_tool_call_output", call_id: "c1", output: "2" },
      ],
    })
    if ("error" in replay) throw new Error("unexpected error")
    expect(replay.request.input).toEqual([
      { type: "function_call", call_id: "c1", name: "exec", arguments: '{"input":"1+1"}' },
      { type: "function_call_output", call_id: "c1", output: "2" },
    ])
  })

  it("accepts custom_tool_call replay items for upstream", () => {
    const replay = normalizeResponsesRequest({
      input: [
        { type: "custom_tool_call", call_id: "c9", name: "exec", input: "1+1" },
        { type: "custom_tool_call_output", call_id: "c9", output: "2" },
      ],
    })
    if ("error" in replay) throw new Error("unexpected error")
    expect(replay.request.input).toEqual([
      { type: "function_call", call_id: "c9", name: "exec", arguments: '{"input":"1+1"}' },
      { type: "function_call_output", call_id: "c9", output: "2" },
    ])
  })

  it("drops all reasoning replay items (session-bound blobs rejected upstream)", () => {
    const result = normalizeResponsesRequest({
      input: [
        { type: "reasoning", id: "rs_bad" },
        { type: "reasoning", id: "rs_ok", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "ENC" },
      ],
    })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.request.input).toEqual([])
  })

  it("rejects item_reference (stateless proxy) and unsupported items", () => {
    const ref = normalizeResponsesRequest({ input: [{ type: "item_reference", id: "resp_x" }] })
    expect("error" in ref).toBe(true)

    const junk = normalizeResponsesRequest({ input: [{ type: "mystery" }] })
    expect("error" in junk).toBe(true)
  })

  it("rejects previous_response_id and missing input", () => {
    const prev = normalizeResponsesRequest({ input: "hi", previous_response_id: "resp_123" })
    expect("error" in prev && prev.error.code).toBe("previous_response_id_unsupported")

    const noInput = normalizeResponsesRequest({})
    expect("error" in noInput && noInput.error.code).toBe("missing_input")
  })

  it("always sends the full builtin tool set with stubbed descriptions, then client tools; tool_choice is auto", () => {
    const result = normalizeResponsesRequest({
      input: "hi",
      tools: [
        { type: "function", name: "my_tool", description: "mine", parameters: { type: "object", properties: {} } },
        // chat-nested shape tolerated
        { type: "function", function: { name: "nested", description: "nested tool", parameters: { type: "object" } } },
        // builtin name from the client replaces the stub entry in place
        { type: "function", name: "bash", description: "client fake bash", parameters: {} },
      ],
    })
    if ("error" in result) throw new Error("unexpected error")
    const tools = result.request.tools!
    expect(tools).toHaveLength(OPENCODE_BUILTIN_TOOLS.length + 2)
    for (const builtin of OPENCODE_BUILTIN_TOOLS) {
      const sent = tools.find((t) => t.name === builtin.name)!
      if (builtin.name === "bash") {
        expect(sent.description).toBe("client fake bash")
      } else {
        expect(sent.description).toBe(STUB_BUILTIN_TOOL_DESCRIPTION)
      }
    }
    expect(tools.at(-2)).toEqual({ type: "function", name: "my_tool", description: "mine", parameters: { type: "object", properties: {} } })
    expect(tools.at(-1)!.name).toBe("nested")
    expect(result.request.tool_choice).toBe("auto")
  })

  it("clamps max_output_tokens and passes temperature/top_p; maps reasoning effort with whitelist", () => {
    const result = normalizeResponsesRequest({
      input: "hi",
      temperature: 0.5,
      top_p: 0.9,
      max_output_tokens: 999_999,
      reasoning: { effort: "xhigh" },
    })
    if ("error" in result) throw new Error("unexpected error")
    expect(result.request.max_output_tokens).toBe(32_000)
    expect(result.request.temperature).toBe(0.5)
    expect(result.request.top_p).toBe(0.9)
    expect(result.request.reasoning!.effort).toBe("xhigh")

    const invalid = normalizeResponsesRequest({ input: "hi", reasoning: { effort: "bogus" } })
    if ("error" in invalid) throw new Error("unexpected error")
    expect(invalid.request.reasoning!.effort).toBe("high")
  })
})

// ---------------------------------------------------------------------------
// handleResponsesRequest integration tests (mocked upstream)
// ---------------------------------------------------------------------------

describe("responses endpoint integration", () => {
  let calls: FetchCall[] = []
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    calls = []
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockUpstream(responses: Response[]): ResponsesDependencies {
    let index = 0
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const response = responses[Math.min(index, responses.length - 1)]!
      index++
      return response
    }) as typeof fetch
    return {}
  }

  it("rejects bad auth, wrong method, and malformed JSON", async () => {
    const unauth = await handleResponsesRequest(post({ input: "hi" }), { PROXY_API_KEY: "other-key" })
    expect(unauth.status).toBe(401)

    const get = new Request("http://localhost/v1/responses", { method: "GET", headers: AUTH })
    const methodRes = await handleResponsesRequest(get, ENV)
    expect(methodRes.status).toBe(405)

    const badJson = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: "not json",
    })
    const jsonRes = await handleResponsesRequest(badJson, ENV)
    expect(jsonRes.status).toBe(400)
  })

  it("non-streaming: aggregates output items, output_text, usage; sends the full fingerprint upstream", async () => {
    mockUpstream([
      sseResponse([
        {
          type: "response.created",
          response: { id: "resp_upstream_1", usage: null },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello " }],
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "world" }],
          },
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
        },
      ]),
    ])

    const res = await handleResponsesRequest(post({ model: "gpt-anything", input: "say hi" }), ENV)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(body.id).toBe("resp_upstream_1")
    expect(body.object).toBe("response")
    expect(body.status).toBe("completed")
    expect(body.model).toBe(MODEL_ID)
    expect(body.output_text).toBe("Hello world")
    expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 2, total_tokens: 7 })
    expect((body.output as unknown[]).length).toBe(2)

    // Fingerprint headers identical to the chat facade.
    const init = calls[0]!.init!
    const headers = init.headers as Record<string, string>
    expect(calls[0]!.url).toBe("https://opencode.ai/zen/v1/responses")
    expect(headers["user-agent"]).toContain("opencode/")
    expect(headers["x-opencode-client"]).toBe("cli")
    expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(headers["x-opencode-request"]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(headers["x-opencode-project"]).toBe("global")

    // Upstream body contract.
    const upstreamBody = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(upstreamBody.model).toBe(MODEL_ID)
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.store).toBe(false)
    expect(upstreamBody.include).toEqual(["reasoning.encrypted_content"])
    expect(upstreamBody.prompt_cache_key).toBe(headers["x-opencode-session"])
    expect(upstreamBody.tool_choice).toBe("auto")
    expect((upstreamBody.tools as unknown[]).length).toBe(OPENCODE_BUILTIN_TOOLS.length)
  })

  it("non-streaming: function_call items surface in output and incomplete status maps through", async () => {
    mockUpstream([
      sseResponse([
        {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "call_9", name: "lookup", arguments: '{"q":"x"}' },
        },
        {
          type: "response.incomplete",
          response: {
            usage: { input_tokens: 3, output_tokens: 1 },
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ]),
    ])

    const res = await handleResponsesRequest(post({ input: "hi" }), ENV)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe("incomplete")
    expect(body.incomplete_details).toEqual({ reason: "max_output_tokens" })
    const output = body.output as Array<Record<string, unknown>>
    expect(output[0]).toEqual({ type: "function_call", call_id: "call_9", name: "lookup", arguments: '{"q":"x"}' })
  })

  it("non-streaming: upstream failure event becomes a 502 error body", async () => {
    mockUpstream([
      sseResponse([{ type: "response.failed", response: { error: { code: "provider_error", message: "boom" } } }]),
    ])
    const res = await handleResponsesRequest(post({ input: "hi" }), ENV)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { message: string; code: string } }
    expect(body.error.message).toBe("boom")
    expect(body.error.code).toBe("provider_error")
  })

  it("oa-compat streaming exposes the complete Responses function-call lifecycle for OpenMinis", async () => {
    mockUpstream([
      sseResponse([
        {
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_file", function: { name: "file_write", arguments: '{"tool_title"' } }] }, finish_reason: null }],
        },
        {
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"写入文件","path":"/root/pelican.html","content":"ok","append":false,"create_dirs":true}' } }] }, finish_reason: null }],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]),
    ])

    const res = await handleResponsesRequest(
      post({
        model: "space-bunny-free",
        input: "写入文件",
        stream: true,
        tools: [{
          type: "function",
          name: "file_write",
          description: "Write content to a file.",
          parameters: {
            type: "object",
            properties: {
              tool_title: { type: "string" },
              path: { type: "string" },
              content: { type: "string" },
              append: { type: "boolean" },
              create_dirs: { type: "boolean" },
            },
            required: ["tool_title", "path", "content"],
          },
        }],
      }),
      ENV,
    )
    expect(res.status).toBe(200)
    const frames = (await res.text())
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((block) => {
        const lines = block.split("\n")
        return { type: lines[0]!.slice(7), data: JSON.parse(lines[1]!.slice(6)) as Record<string, unknown> }
      })
    const types = frames.map((frame) => frame.type)
    expect(types[0]).toBe("response.created")
    expect(types).toContain("response.output_item.added")
    expect(types).toContain("response.function_call_arguments.delta")
    expect(types).toContain("response.function_call_arguments.done")
    expect(types).toContain("response.output_item.done")
    expect(types.indexOf("response.output_item.added")).toBeLessThan(types.indexOf("response.function_call_arguments.delta"))
    expect(types.indexOf("response.function_call_arguments.delta")).toBeLessThan(types.indexOf("response.output_item.done"))
    expect(types.at(-1)).toBe("response.completed")

    const added = frames.find((frame) => frame.type === "response.output_item.added")!.data as { item: { id: string } }
    const done = frames.find((frame) => frame.type === "response.output_item.done")!.data as { item: { id: string; call_id: string; name: string; arguments: string } }
    expect(added.item.id).toBe(done.item.id)
    expect(added.item.id).toMatch(/^fc_/)
    const argumentDelta = frames.find((frame) => frame.type === "response.function_call_arguments.delta")!.data as { item_id: string; delta: string }
    expect(argumentDelta.item_id).toBe(done.item.id)
    expect(done.item.call_id).toBe("call_file")
    expect(done.item.name).toBe("file_write")
    expect(done.item.arguments).toContain('"create_dirs":true')
    const deltas = frames
      .filter((frame) => frame.type === "response.function_call_arguments.delta")
      .map((frame) => (frame.data as { delta?: string }).delta ?? "")
      .join("")
    expect(deltas).toBe(done.item.arguments)
  })

  it("streaming: forwards upstream events verbatim with event:/data: framing and no [DONE] line", async () => {
    mockUpstream([
      sseResponse([
        { type: "response.created", response: { id: "resp_s1" } },
        { type: "response.output_text.delta", delta: "Hel" },
        { type: "response.output_text.delta", delta: "lo" },
        { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ]),
    ])

    const res = await handleResponsesRequest(post({ input: "hi", stream: true }), ENV)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const text = await res.text()
    expect(text).not.toContain("[DONE]")

    // Each upstream event must appear exactly once, framed as
    // `event: <type>\ndata: <json>`.
    const frames = text.split("\n\n").filter((block) => block.startsWith("event: "))
    expect(frames).toHaveLength(4)
    const types = frames.map((frame) => frame.split("\n")[0]!.slice("event: ".length))
    expect(types).toEqual(["response.created", "response.output_text.delta", "response.output_text.delta", "response.completed"])

    const payload = JSON.parse(frames[1]!.split("\n")[1]!.slice("data: ".length)) as { type: string; delta: string }
    expect(payload).toEqual({ type: "response.output_text.delta", delta: "Hel" })
  })

  it("streaming: drops upstream ping keep-alive frames so response.completed stays terminal", async () => {
    mockUpstream([
      sseResponse([
        { type: "response.created", response: { id: "resp_p1" } },
        { type: "ping" },
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        { type: "ping" },
      ]),
    ])

    const res = await handleResponsesRequest(post({ input: "hi", stream: true }), ENV)
    const text = await res.text()

    // No ping frames leak through in either event: type or data payload.
    expect(text).not.toContain("ping")
    const frames = text.split("\n\n").filter((block) => block.startsWith("event: "))
    const types = frames.map((frame) => frame.split("\n")[0]!.slice("event: ".length))
    expect(types).toEqual(["response.created", "response.output_text.delta", "response.completed"])
    // The terminal frame is the spec-required response.completed.
    expect(types.at(-1)).toBe("response.completed")
  })

  it("streaming: upstream EOF without a terminal event surfaces a synthetic error event", async () => {
    mockUpstream([
      sseResponse([
        { type: "response.created", response: { id: "resp_t1" } },
        { type: "response.output_text.delta", delta: "truncat" },
      ]),
    ])
    const res = await handleResponsesRequest(post({ input: "hi", stream: true }), ENV)
    const text = await res.text()
    expect(text).toContain("upstream_stream_truncated")
    expect(text).toContain("upstream closed the stream before a terminal response event")
    const types = text
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((frame) => frame.split("\n")[0]!.slice("event: ".length))
    expect(types.at(-1)).toBe("error")
  })

  it("non-streaming: upstream EOF without a terminal event returns 502 instead of a completed response", async () => {
    mockUpstream([
      sseResponse([
        { type: "response.output_text.delta", delta: "partial" },
      ]),
    ])
    const res = await handleResponsesRequest(post({ input: "hi" }), ENV)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("upstream_stream_truncated")
  })

  it("streaming: mid-stream failure surfaces a framed error event", async () => {
    mockUpstream([
      sseResponse([
        { type: "response.output_text.delta", delta: "partial" },
        { type: "error", code: "overloaded", message: "upstream exploded" },
      ]),
    ])
    const res = await handleResponsesRequest(post({ input: "hi", stream: true }), ENV)
    const text = await res.text()
    expect(text).toContain('"type":"error"')
    expect(text).toContain("upstream exploded")
  })

  it("maps upstream 429 to a 429 error body", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), { status: 429 })) as typeof fetch
    const res = await handleResponsesRequest(post({ input: "hi" }), ENV)
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("rate_limit_error")
  })

  it("rejects unsupported input items with 400 before contacting upstream", async () => {
    const res = await handleResponsesRequest(post({ input: [{ type: "item_reference", id: "x" }] }), ENV)
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
  it("non-streaming: restores namespace prefix on client function_call items", async () => {
    mockUpstream([
      sseResponse([
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"x"}' },
        },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]),
    ])
    const res = await handleResponsesRequest(
      post({
        input: "hi",
        tools: [
          {
            type: "namespace",
            name: "muse",
            description: "Muse Code tool set.",
            tools: [{ type: "function", name: "read_file", description: "read", parameters: { type: "object", properties: {} } }],
          },
        ],
      }),
      ENV,
    )
    const body = (await res.json()) as Record<string, unknown>
    const output = body.output as Array<Record<string, unknown>>
    expect(output.map((item) => item.name)).toEqual(["muse__read_file"])
  })


  it("non-streaming: drops hidden builtin function_call items but keeps client calls", async () => {
    mockUpstream([
      sseResponse([
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: '{"command":"x"}' },
        },
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "websearch", arguments: '{"query":"x"}' },
        },
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_3", call_id: "call_3", name: "get_weather", arguments: '{"city":"x"}' },
        },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]),
    ])
    const res = await handleResponsesRequest(post({ input: "hi" }), ENV)
    const body = (await res.json()) as Record<string, unknown>
    const output = body.output as Array<Record<string, unknown>>
    expect(output.map((item) => item.name)).toEqual(["get_weather"])
  })

  it("streaming: drops the full hidden function_call event sequence but forwards client calls", async () => {
    mockUpstream([
      sseResponse([
        { type: "response.created", response: { id: "resp_hidden" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "fc_hidden", type: "function_call", status: "in_progress", name: "bash", call_id: "call_h", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_hidden", delta: '{"co' },
        { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_hidden", arguments: '{"co"}', name: "bash" },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { id: "fc_hidden", type: "function_call", status: "completed", name: "bash", call_id: "call_h", arguments: '{"co"}' },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { id: "fc_client", type: "function_call", status: "in_progress", name: "get_weather", call_id: "call_c", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_client", delta: '{"ci' },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: { id: "fc_client", type: "function_call", status: "completed", name: "get_weather", call_id: "call_c", arguments: '{"ci"}' },
        },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]),
    ])
    const res = await handleResponsesRequest(post({ input: "hi", stream: true }), ENV)
    const text = await res.text()
    expect(text).not.toContain('"bash"')
    expect(text).not.toContain("fc_hidden")
    expect(text).not.toContain('call_h')
    expect(text).toContain('"get_weather"')
    expect(text).toContain("fc_client")
    const frames = text.split("\n\n").filter((block) => block.startsWith("event: "))
    const types = frames.map((frame) => frame.split("\n")[0]!.slice("event: ".length))
    // 隐藏调用的 delta 已丢弃：剩下唯一的 arguments.delta 属于客户端工具。
    expect(types.filter((type) => type === "response.function_call_arguments.delta")).toHaveLength(1)
    expect(text).toContain("fc_client")
    expect(types.at(-1)).toBe("response.completed")
  })

  it("streaming: rewrites upstream function_call/exec to custom_tool_call downstream", async () => {
    mockUpstream([
      sseResponse([
        {
          type: "response.output_item.added",
          item: { id: "fc_e1", type: "function_call", name: "exec", call_id: "call_e1", arguments: "" },
        },
        {
          type: "response.output_item.done",
          item: { id: "fc_e1", type: "function_call", name: "exec", call_id: "call_e1", arguments: '{"input":"1+1"}' },
        },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]),
    ])
    const res = await handleResponsesRequest(
      post({
        input: "hi",
        stream: true,
        tools: [{ type: "custom", name: "exec", description: "Run JS.", format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" } }],
      }),
      ENV,
    )
    const text = await res.text()
    expect(text).toContain('"custom_tool_call"')
    expect(text).toContain('"input":"1+1"')
    expect(text).not.toContain('"function_call"')
    const types = text.split("\n\n").filter((block) => block.startsWith("event: ")).map((frame) => frame.split("\n")[0]!.slice("event: ".length))
    expect(types.at(-1)).toBe("response.completed")
  })

  it("streaming: client abort closes silently without a synthetic error event", async () => {
    const controller = new AbortController()
    const hanging = new Response(
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_abort"}}\n\n'))
          controller.signal.addEventListener("abort", () => {
            ctrl.error(new DOMException("The operation was aborted.", "AbortError"))
          })
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
    const deps = { fetchImpl: (async () => hanging) as typeof fetch }
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ input: "hi", stream: true }),
      signal: controller.signal,
    })
    const res = await handleResponsesRequest(req, ENV, deps)
    const readPromise = res.text()
    controller.abort()
    const text = await readPromise
    expect(text).not.toContain("proxy_stream_error")
    expect(text).not.toContain("upstream_stream_truncated")
  })

  it("drops multi-turn encrypted reasoning replay instead of sending it upstream", async () => {
    mockUpstream([sseResponse([{ type: "response.completed", response: {} }])])
    await handleResponsesRequest(
      post({
        input: [
          { role: "user", content: "hi" },
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "ENC-1" },
          { type: "function_call", call_id: "c1", name: "echo", arguments: "{}" },
          { type: "function_call_output", call_id: "c1", output: "ok" },
        ],
      }),
      ENV,
    )
    const body = JSON.parse(String(calls[0]!.init!.body)) as { input: Array<Record<string, unknown>> }
    const types = body.input.map((item) => ("role" in item ? item.role : item.type))
    expect(types).toEqual(["user", "function_call", "function_call_output"])
  })
})
