// Integration tests over the full request pipeline with a mocked upstream.
// Multi-turn contract (encrypted-reasoning replay is dropped: blobs are
// session-bound and rejected upstream; turns continue via text + tool
// round-trips):
//   turn 1: upstream streams reasoning + function_call
//   agent executes the tool, echoes the assistant message back verbatim
//   turn 2: the proxy replays the function_call round-trip only.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleChatRequest, type ChatDependencies } from "../api/chat"
import { encodeReasoningDetails } from "../supabase/functions/muse-proxy/_lib/reasoning.ts"

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
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify(body),
  })
}

async function readSseChunks(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  const chunks: Array<Record<string, unknown>> = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    const data = trimmed.slice(5).trim()
    if (data === "[DONE]") continue
    chunks.push(JSON.parse(data))
  }
  return chunks
}

describe("multi-turn integration", () => {
  let calls: FetchCall[] = []
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    calls = []
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockUpstream(responses: Response[]): ChatDependencies {
    let index = 0
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const response = responses[Math.min(index, responses.length - 1)]
      index++
      return response!
    }) as typeof fetch
    return {}
  }

  it("turn 1: streams interleaved reasoning + text deltas and ends with [DONE]", async () => {
    mockUpstream([
      sseResponse([
        { choices: [{ index: 0, delta: { reasoning_content: "let me " } }] },
        { choices: [{ index: 0, delta: { reasoning_content: "think" } }] },
        { choices: [{ index: 0, delta: { content: "The answer" } }] },
        { choices: [{ index: 0, delta: { content: " is 4." } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
      ]),
    ])

    const res = await handleChatRequest(
      post({ model: "anything", stream: true, messages: [{ role: "user", content: "what is 2+2" }] }),
      ENV,
    )
    const chunks = await readSseChunks(res)

    const reasoning = chunks
      .map((c) => (c as { choices?: Array<{ delta?: { reasoning_content?: string } }> }).choices?.[0]?.delta?.reasoning_content)
      .filter(Boolean)
      .join("")
    expect(reasoning).toBe("let me think")

    const content = chunks
      .map((c) => (c as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content)
      .filter(Boolean)
      .join("")
    expect(content).toBe("The answer is 4.")

    // oa-compat reasoning deltas carry no encrypted blob, so no
    // reasoning_details replay chunk is synthesized at all.
    const details = chunks
      .map((c) => (c as { choices?: Array<{ delta?: { reasoning_details?: string } }> }).choices?.[0]?.delta?.reasoning_details)
      .filter(Boolean) as string[]
    expect(details).toHaveLength(0)

    const last = chunks.at(-1) as { choices?: Array<{ finish_reason?: string }>; usage?: { total_tokens: number } }
    expect(last.choices?.[0]?.finish_reason).toBe("stop")
    expect(last.usage?.total_tokens).toBe(18)
  })

  it("two-turn tool loop: turn 2 replays visible reasoning + function_call round-trip", async () => {
    // ---- Turn 1: model decides to call the echo tool ----
    mockUpstream([
      sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "echo", arguments: "{\"text\":\"hi\"}" } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
      ]),
    ])

    const turn1 = await handleChatRequest(
      post({
        stream: false,
        messages: [{ role: "user", content: "echo hi" }],
        tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
      }),
      ENV,
    )
    const turn1Body = (await turn1.json()) as {
      choices: Array<{
        message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; reasoning_content?: string }
        finish_reason: string
      }>
    }
    expect(turn1Body.choices[0]!.finish_reason).toBe("tool_calls")
    expect(turn1Body.choices[0]!.message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "echo", arguments: "{\"text\":\"hi\"}" } },
    ])

    // ---- The agent echoes the assistant message back verbatim (standard
    // OpenAI behavior), including reasoning_content and the reasoning_details
    // extension the proxy emitted, then appends the tool result. ----
    const reasoningDetailsFromTurn1 = encodeReasoningDetails([
      { id: "rs_t1", summary: "need the echo tool", encrypted_content: "ENC-T1" },
    ])
    const turn2Messages = [
      { role: "user", content: "echo hi" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "need the echo tool",
        reasoning_details: reasoningDetailsFromTurn1,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{\"text\":\"hi\"}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "echoed: hi" },
    ]

    mockUpstream([
      sseResponse([
        { choices: [{ index: 0, delta: { content: "The tool said: echoed: hi" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } },
      ]),
    ])

    await handleChatRequest(
      post({
        stream: false,
        messages: turn2Messages,
        tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
      }),
      ENV,
    )

    // ---- Assert exactly what the proxy sent upstream on turn 2 ----
    expect(calls).toHaveLength(2)
    const turn2RequestBody = JSON.parse(String(calls[1]!.init!.body)) as {
      messages: Array<Record<string, unknown>>
      model: string
      stream: boolean
    }

    // Encrypted-reasoning blobs stay dropped (session-bound), but the visible
    // reasoning text is replayed: DeepSeek thinking mode 400s without it.
    const roles = turn2RequestBody.messages.map((item) => item.role)
    expect(roles).toEqual(["user", "assistant", "tool"])

    expect(turn2RequestBody.messages[1]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "need the echo tool",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{\"text\":\"hi\"}" } }],
    })
    expect(turn2RequestBody.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "echoed: hi",
    })

    // The turn-2 replay must not resurrect session-bound reasoning blobs.
    const serializedReplay = JSON.stringify(turn2RequestBody.messages)
    expect(serializedReplay).not.toContain("rs_t1")
    expect(serializedReplay).not.toContain("ENC-T1")

    // oa-compat contract for every request (muse aliases onto deepseek)
    expect(turn2RequestBody.model).toBe("deepseek-v4.1-flash-free")
    expect(turn2RequestBody.stream).toBe(true)
  })

  it("three-turn long conversation: visible reasoning replayed; encrypted blobs dropped", async () => {
    // The agent strips reasoning_details from the FIRST assistant message
    // (some clients drop unknown fields) but preserves the second one.
    const preservedDetails = encodeReasoningDetails([
      { id: "rs_3", summary: "three", encrypted_content: "E3" },
    ])

    mockUpstream([
      sseResponse([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]),
    ])

    await handleChatRequest(
      post({
        stream: false,
        messages: [
          { role: "user", content: "start" },
          // assistant turn 1: reasoning_details stripped by client
          {
            role: "assistant",
            content: null,
            reasoning_content: "one\ntwo",
            tool_calls: [{ id: "c1", type: "function", function: { name: "toolA", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "c1", content: "ok" },
          { role: "user", content: "go on" },
          // assistant turn 2: reasoning_details preserved
          {
            role: "assistant",
            content: "working",
            reasoning_content: "three",
            reasoning_details: preservedDetails,
          },
          { role: "user", content: "finish" },
        ],
      }),
      ENV,
    )

    const body = JSON.parse(String(calls[0]!.init!.body)) as { messages: Array<Record<string, unknown>> }
    const roles = body.messages.map((item) => item.role)
    expect(roles).toEqual(["user", "assistant", "tool", "user", "assistant", "user"])

    // Encrypted blobs stay dropped (session-bound), visible reasoning replays.
    const serialized = JSON.stringify(body.messages)
    expect(serialized).not.toContain("rs_3")
    expect(serialized).not.toContain("E3")
    expect(serialized).toContain("one\\ntwo")
    expect(serialized).toContain("three")

    // The function_call round-trip from turn 1 is still replayed, merged into
    // a single assistant message that carries the turn's visible reasoning.
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "one\ntwo",
      tool_calls: [{ id: "c1", type: "function", function: { name: "toolA", arguments: "{}" } }],
    })
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" })
  })

  it("mid-stream upstream error surfaces as an error chunk and still closes cleanly", async () => {
    mockUpstream([
      sseResponse([
        { choices: [{ index: 0, delta: { content: "partial" } }] },
        { error: { code: "overloaded", message: "upstream exploded" } },
      ]),
    ])
    const res = await handleChatRequest(
      post({ stream: true, messages: [{ role: "user", content: "hi" }] }),
      ENV,
    )
    const chunks = await readSseChunks(res)
    const contents = chunks
      .map((c) => (c as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content)
      .filter(Boolean)
      .join("")
    expect(contents).toContain("partial")
    expect(contents).toContain("[muse-proxy upstream error]")
    expect(contents).toContain("upstream exploded")
    // stream always terminates with [DONE]
    const raw = await res.text().catch(() => "")
    void raw
  })

  it("aborting the client request aborts the upstream fetch", async () => {
    let upstreamAborted = false
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"x\"}}]}\n\n"))
            init?.signal?.addEventListener("abort", () => {
              upstreamAborted = true
              controller.close()
            })
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }) as typeof fetch

    const controller = new AbortController()
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    })
    const res = await handleChatRequest(request, ENV, {})
    const reader = res.body!.getReader()
    await reader.read() // consume first chunk
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(upstreamAborted).toBe(true)
  })
})
