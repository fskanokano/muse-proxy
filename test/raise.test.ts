import { describe, expect, it } from "vitest"
import { createRaiser } from "../api/_lib/raise"

const ID = "chatcmpl-test"
const CREATED = 1_700_000_000
const MODEL = "muse-spark-1.3-contributor-free"

function raiser() {
  return createRaiser({ id: ID, created: CREATED, model: MODEL })
}

function chunkFrom(events: Parameters<ReturnType<typeof createRaiser>["handle"]>[0]) {
  const r = raiser()
  return r.handle(events)
}

const baseChunk = { id: ID, object: "chat.completion.chunk" as const, created: CREATED, model: MODEL }

describe("raise: text and reasoning deltas", () => {
  it("maps output_text.delta to content", () => {
    const chunks = chunkFrom({ type: "response.output_text.delta", delta: "hello" })
    expect(chunks).toEqual([
      { ...baseChunk, choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
    ])
  })

  it("maps reasoning_summary_text.delta to reasoning_content", () => {
    const chunks = chunkFrom({ type: "response.reasoning_summary_text.delta", delta: "thinking" })
    expect(chunks).toEqual([
      { ...baseChunk, choices: [{ index: 0, delta: { reasoning_content: "thinking" }, finish_reason: null }] },
    ])
  })

  it("ignores empty deltas", () => {
    expect(chunkFrom({ type: "response.output_text.delta" })).toEqual([])
  })

  it("ignores unknown event types", () => {
    expect(chunkFrom({ type: "response.output_item.added" })).toEqual([])
    expect(chunkFrom({ type: "heartbeat" })).toEqual([])
  })
})

describe("raise: reasoning item collection", () => {
  it("emits a reasoning_details chunk when a reasoning item completes with encrypted content", () => {
    const r = raiser()
    const doneChunks = r.handle({
      type: "response.output_item.done",
      item: {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "enc-abc",
        summary: [{ type: "summary_text", text: "chain of thought" }],
      },
    })
    expect(doneChunks).toEqual([
      {
        ...baseChunk,
        choices: [
          {
            index: 0,
            delta: { reasoning_details: expect.stringMatching(/^[A-Za-z0-9+/=]+$/) },
            finish_reason: null,
          },
        ],
      },
    ])
    // The encoded payload must round-trip to the original reasoning item.
    const payload = JSON.parse(
      Buffer.from(doneChunks[0]!.choices[0]!.delta.reasoning_details as string, "base64").toString("utf8"),
    )
    expect(payload).toEqual({
      v: 1,
      items: [{ id: "rs_1", summary: "chain of thought", encrypted_content: "enc-abc" }],
    })
  })

  it("does not emit reasoning_details for items without encrypted content", () => {
    const chunks = chunkFrom({
      type: "response.output_item.done",
      item: { type: "reasoning", id: "rs_2", encrypted_content: null, summary: [] },
    })
    expect(chunks).toEqual([])
  })
})

describe("raise: tool calls", () => {
  it("emits tool_call delta and arms finish_reason tool_calls", () => {
    const r = raiser()
    const chunks = r.handle({
      type: "response.output_item.done",
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo", arguments: "{\"x\":1}" },
    })
    expect(chunks).toEqual([
      {
        ...baseChunk,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "echo", arguments: "{\"x\":1}" } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    ])

    const finish = r.finish()
    expect(finish).toHaveLength(1)
    expect(finish[0]!.choices[0]!.finish_reason).toBe("tool_calls")
    expect(finish[0]!.choices[0]!.delta).toEqual({})
  })

  it("increments tool_call index per call", () => {
    const r = raiser()
    r.handle({
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "c1", name: "a", arguments: "{}" },
    })
    r.handle({
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "c2", name: "b", arguments: "{}" },
    })
    const chunks = r.handle({
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "c3", name: "c", arguments: "{}" },
    })
    expect(chunks[0]!.choices[0]!.delta.tool_calls?.[0]?.index).toBe(2)
  })
})

describe("raise: completion", () => {
  it("maps response.completed to a finish chunk with usage", () => {
    const r = raiser()
    const chunks = r.handle({
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    })
    expect(chunks).toEqual([
      {
        ...baseChunk,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      },
    ])
  })

  it("tool_calls finish wins over stop when tools were emitted", () => {
    const r = raiser()
    r.handle({
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "c1", name: "a", arguments: "{}" },
    })
    const finish = r.handle({ type: "response.completed", response: {} })
    expect(finish[0]!.choices[0]!.finish_reason).toBe("tool_calls")
  })

  it("maps response.incomplete to length", () => {
    const chunks = chunkFrom({
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    })
    expect(chunks[0]!.choices[0]!.finish_reason).toBe("length")
  })

  it("maps mid-stream error events to an error text chunk", () => {
    const chunks = chunkFrom({ type: "error", code: "boom", message: "exploded" })
    expect(chunks[0]!.choices[0]!.delta.content).toContain("[muse-proxy upstream error]")
    expect(chunks[0]!.choices[0]!.delta.content).toContain("exploded")
  })

  it("maps response.failed to an error text chunk", () => {
    const chunks = chunkFrom({
      type: "response.failed",
      response: { error: { code: "rate_limit", message: "slow down" } },
    })
    expect(chunks[0]!.choices[0]!.delta.content).toContain("slow down")
  })
})
