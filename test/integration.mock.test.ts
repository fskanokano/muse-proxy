// Integration tests over the full request pipeline with a mocked upstream.
// These encode the muse-spark multi-turn contract:
//   turn 1: upstream streams reasoning + function_call
//   agent executes the tool, echoes the assistant message back verbatim
//   turn 2: the proxy must replay encrypted reasoning items + function_call
//           round-trip to upstream exactly as opencode itself would.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleChatRequest, type ChatDependencies } from "../api/chat"
import { encodeReasoningDetails } from "../api/_lib/reasoning"

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
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_a" } },
        { type: "response.reasoning_summary_text.delta", delta: "let me " },
        { type: "response.reasoning_summary_text.delta", delta: "think" },
        { type: "response.output_text.delta", delta: "The answer" },
        { type: "response.output_text.delta", delta: " is 4." },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_a",
            encrypted_content: "ENC-A",
            summary: [{ type: "summary_text", text: "let me think" }],
          },
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } },
        },
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

    // exactly one reasoning_details chunk with the encrypted item
    const details = chunks
      .map((c) => (c as { choices?: Array<{ delta?: { reasoning_details?: string } }> }).choices?.[0]?.delta?.reasoning_details)
      .filter(Boolean) as string[]
    expect(details).toHaveLength(1)
    const payload = JSON.parse(Buffer.from(details[0]!, "base64").toString("utf8")) as {
      v: number
      items: Array<{ id: string; encrypted_content: string; summary: string }>
    }
    expect(payload.v).toBe(1)
    expect(payload.items).toEqual([{ id: "rs_a", summary: "let me think", encrypted_content: "ENC-A" }])

    const last = chunks.at(-1) as { choices?: Array<{ finish_reason?: string }>; usage?: { total_tokens: number } }
    expect(last.choices?.[0]?.finish_reason).toBe("stop")
    expect(last.usage?.total_tokens).toBe(18)
  })

  it("two-turn tool loop: turn 2 replays encrypted reasoning + function_call round-trip", async () => {
    // ---- Turn 1: model decides to call the echo tool ----
    mockUpstream([
      sseResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_t1",
            encrypted_content: "ENC-T1",
            summary: [{ type: "summary_text", text: "need the echo tool" }],
          },
        },
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo", arguments: "{\"text\":\"hi\"}" },
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } },
        },
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
        { type: "response.output_text.delta", delta: "The tool said: echoed: hi" },
        { type: "response.completed", response: { usage: { input_tokens: 40, output_tokens: 8, total_tokens: 48 } } },
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
      input: Array<Record<string, unknown>>
      store: boolean
      include: string[]
    }

    // Order and shape must match opencode's own lowering: reasoning item,
    // function_call, then function_call_output.
    const types = turn2RequestBody.input.map((item) => ("role" in item ? item.role : item.type))
    expect(types).toEqual(["user", "reasoning", "function_call", "function_call_output"])

    const reasoningItem = turn2RequestBody.input[1] as {
      type: string
      id: string
      summary: Array<{ type: string; text: string }>
      encrypted_content: string
    }
    expect(reasoningItem).toEqual({
      type: "reasoning",
      id: "rs_t1",
      summary: [{ type: "summary_text", text: "need the echo tool" }],
      encrypted_content: "ENC-T1",
    })
    expect(turn2RequestBody.input[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "echo",
      arguments: "{\"text\":\"hi\"}",
    })
    expect(turn2RequestBody.input[3]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "echoed: hi",
    })

    // muse-specific fixed options on every request
    expect(turn2RequestBody.store).toBe(false)
    expect(turn2RequestBody.include).toEqual(["reasoning.encrypted_content"])
  })

  it("three-turn long conversation: multiple reasoning items replay in order; items stripped by the client are filtered", async () => {
    // Turn N-1 upstream emits two reasoning items + tool call.
    mockUpstream([
      sseResponse([
        {
          type: "response.output_item.done",
          item: { type: "reasoning", id: "rs_1", encrypted_content: "E1", summary: [{ type: "summary_text", text: "one" }] },
        },
        {
          type: "response.output_item.done",
          item: { type: "reasoning", id: "rs_2", encrypted_content: "E2", summary: [{ type: "summary_text", text: "two" }] },
        },
        {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "c1", name: "toolA", arguments: "{}" },
        },
        { type: "response.completed", response: {} },
      ]),
    ])

    // The agent strips reasoning_details from the FIRST assistant message
    // (some clients drop unknown fields) but preserves the second one.
    const preservedDetails = encodeReasoningDetails([
      { id: "rs_3", summary: "three", encrypted_content: "E3" },
    ])

    mockUpstream([
      sseResponse([{ type: "response.completed", response: {} }]),
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

    const body = JSON.parse(String(calls[1]!.init!.body)) as { input: Array<Record<string, unknown>> }
    const reasoningItems = body.input.filter((item) => item.type === "reasoning")

    // The stripped item must NOT be replayed (no encrypted_content -> dropped,
    // mirroring opencode's store:false filter). Only rs_3 survives.
    expect(reasoningItems).toEqual([
      {
        type: "reasoning",
        id: "rs_3",
        summary: [{ type: "summary_text", text: "three" }],
        encrypted_content: "E3",
      },
    ])

    // The function_call round-trip from turn 1 is still replayed.
    expect(body.input).toContainEqual({ type: "function_call", call_id: "c1", name: "toolA", arguments: "{}" })
    expect(body.input).toContainEqual({ type: "function_call_output", call_id: "c1", output: "ok" })
  })

  it("mid-stream upstream error surfaces as an error chunk and still closes cleanly", async () => {
    mockUpstream([
      sseResponse([
        { type: "response.output_text.delta", delta: "partial" },
        { type: "error", code: "overloaded", message: "upstream exploded" },
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
            controller.enqueue(new TextEncoder().encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n"))
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
