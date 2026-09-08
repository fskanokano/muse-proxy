import { describe, expect, it } from "vitest"
import { lowerRequest } from "../api/_lib/lower"
import { encodeReasoningDetails, type ReasoningItem } from "../api/_lib/reasoning"

const ok = (result: ReturnType<typeof lowerRequest>) => {
  if ("error" in result) throw new Error(`expected success, got ${JSON.stringify(result.error)}`)
  return result.request
}

const err = (result: ReturnType<typeof lowerRequest>) => {
  if (!("error" in result)) throw new Error("expected error")
  return result.error
}

describe("lowerRequest: basic mapping", () => {
  it("builds a minimal Responses request with fixed options", () => {
    const request = ok(
      lowerRequest({
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(request.model).toBe("muse-spark-1.3-contributor-free")
    expect(request.store).toBe(false)
    expect(request.include).toEqual(["reasoning.encrypted_content"])
    expect(request.reasoning).toEqual({ effort: "high", summary: "auto" })
    expect(request.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }])
    expect(request.stream).toBe(true)
  })

  it("maps any requested model id to the free muse model", () => {
    const request = ok(lowerRequest({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }))
    expect(request.model).toBe("muse-spark-1.3-contributor-free")
  })

  it("merges multiple system messages into one system item", () => {
    const request = ok(
      lowerRequest({
        messages: [
          { role: "system", content: "sys one" },
          { role: "user", content: "q" },
          { role: "system", content: "sys two" },
        ],
      }),
    )
    expect(request.input).toEqual([
      { role: "system", content: "sys one\nsys two" },
      { role: "user", content: [{ type: "input_text", text: "q" }] },
    ])
  })

  it("maps user multimodal content with text and image", () => {
    const request = ok(
      lowerRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      }),
    )
    expect(request.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ])
  })

  it("maps assistant string content", () => {
    const request = ok(
      lowerRequest({
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
          { role: "user", content: "next" },
        ],
      }),
    )
    expect(request.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "q" }] },
      { role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { role: "user", content: [{ type: "input_text", text: "next" }] },
    ])
  })
})

describe("lowerRequest: parameters", () => {
  it("accepts reasoning_effort from the whitelist", () => {
    const request = ok(lowerRequest({ messages: [], reasoning_effort: "xhigh" }))
    expect(request.reasoning?.effort).toBe("xhigh")
  })

  it("accepts reasoning.effort nested form", () => {
    const request = ok(lowerRequest({ messages: [], reasoning: { effort: "low" } }))
    expect(request.reasoning?.effort).toBe("low")
  })

  it("falls back to high for invalid effort values", () => {
    const request = ok(lowerRequest({ messages: [], reasoning_effort: "ultra" }))
    expect(request.reasoning?.effort).toBe("high")
    const request2 = ok(lowerRequest({ messages: [], reasoning_effort: 42 }))
    expect(request2.reasoning?.effort).toBe("high")
  })

  it("clamps max_tokens into max_output_tokens", () => {
    const request = ok(lowerRequest({ messages: [], max_tokens: 999_999 }))
    expect(request.max_output_tokens).toBe(32_000)
    const request2 = ok(lowerRequest({ messages: [], max_completion_tokens: 500 }))
    expect(request2.max_output_tokens).toBe(500)
  })

  it("passes temperature and top_p", () => {
    const request = ok(lowerRequest({ messages: [], temperature: 0.4, top_p: 0.9 }))
    expect(request.temperature).toBe(0.4)
    expect(request.top_p).toBe(0.9)
  })

  it("maps tools and tool_choice", () => {
    const request = ok(
      lowerRequest({
        messages: [],
        tools: [{ type: "function", function: { name: "echo", description: "echo it", parameters: { type: "object" } } }],
        tool_choice: "auto",
      }),
    )
    expect(request.tools).toEqual([
      { type: "function", name: "echo", description: "echo it", parameters: { type: "object" } },
    ])
    expect(request.tool_choice).toBe("auto")
  })

  it("defaults tool parameters when missing", () => {
    const request = ok(
      lowerRequest({
        messages: [],
        tools: [{ type: "function", function: { name: "noargs" } }],
      }),
    )
    expect(request.tools?.[0]?.parameters).toEqual({ type: "object", properties: {} })
  })
})

describe("lowerRequest: encrypted reasoning replay", () => {
  const item = (id: string, enc: string, summary: string): ReasoningItem => ({
    id,
    summary,
    encrypted_content: enc,
  })

  it("decodes reasoning_details and places reasoning items before assistant text", () => {
    const details = encodeReasoningDetails([item("rs_1", "enc-1", "hmm")])
    const request = ok(
      lowerRequest({
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: "answer",
            reasoning_details: details,
          },
          { role: "user", content: "follow-up" },
        ],
      }),
    )
    expect(request.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "q" }] },
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "hmm" }], encrypted_content: "enc-1" },
      { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { role: "user", content: [{ type: "input_text", text: "follow-up" }] },
    ])
  })

  it("drops replay items that lost their encrypted_content", () => {
    // Client stripped reasoning_details entirely: no reasoning items at all.
    const request = ok(
      lowerRequest({
        messages: [
          { role: "assistant", content: "a", reasoning_content: "visible thinking" },
          { role: "user", content: "next" },
        ],
      }),
    )
    expect(request.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { role: "user", content: [{ type: "input_text", text: "next" }] },
    ])
  })

  it("merges same-id fragments and drops broken payloads", () => {
    const details = encodeReasoningDetails([
      item("rs_1", "enc-old", "first"),
      item("rs_1", "enc-new", "second"),
    ])
    const request = ok(
      lowerRequest({
        messages: [
          { role: "assistant", content: "a", reasoning_details: details },
          { role: "user", content: "next" },
        ],
      }),
    )
    expect(request.input).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        // same-id fragments merge into one summary entry (matches opencode's
        // single-part replay shape); encrypted_content keeps the latest value
        summary: [{ type: "summary_text", text: "first\nsecond" }],
        encrypted_content: "enc-new",
      },
      { role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { role: "user", content: [{ type: "input_text", text: "next" }] },
    ])
  })

  it("tolerates array-shaped reasoning_details by ignoring them", () => {
    const request = ok(
      lowerRequest({
        messages: [
          { role: "assistant", content: "a", reasoning_details: [{ some: "custom" }] },
          { role: "user", content: "next" },
        ],
      }),
    )
    expect(request.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { role: "user", content: [{ type: "input_text", text: "next" }] },
    ])
  })
})

describe("lowerRequest: tool calls and tool results", () => {
  it("maps assistant tool_calls and role:tool messages", () => {
    const request = ok(
      lowerRequest({
        messages: [
          { role: "user", content: "run it" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "echo", arguments: "{\"text\":\"hi\"}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "echoed hi" },
        ],
      }),
    )
    expect(request.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "run it" }] },
      { type: "function_call", call_id: "call_1", name: "echo", arguments: "{\"text\":\"hi\"}" },
      { type: "function_call_output", call_id: "call_1", output: "echoed hi" },
    ])
  })

  it("joins array content of tool results", () => {
    const request = ok(
      lowerRequest({
        messages: [{ role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "part " }, { type: "text", text: "two" }] }],
      }),
    )
    expect(request.input).toEqual([{ type: "function_call_output", call_id: "c1", output: "part two" }])
  })

  it("stringifies object tool results", () => {
    const request = ok(
      lowerRequest({
        messages: [{ role: "tool", tool_call_id: "c1", content: { result: 42 } }],
      }),
    )
    expect(request.input).toEqual([{ type: "function_call_output", call_id: "c1", output: "{\"result\":42}" }])
  })
})

describe("lowerRequest: validation", () => {
  it("rejects missing messages", () => {
    expect(err(lowerRequest({})).status).toBe(400)
  })

  it("rejects non-array messages", () => {
    expect(err(lowerRequest({ messages: "nope" })).status).toBe(400)
  })

  it("rejects messages that are not objects", () => {
    expect(err(lowerRequest({ messages: ["hello"] })).status).toBe(400)
  })

  it("rejects unsupported roles", () => {
    expect(err(lowerRequest({ messages: [{ role: "coordinator", content: "x" }] })).status).toBe(400)
  })

  it("treats the developer role as a system instruction", () => {
    const request = ok(lowerRequest({ messages: [{ role: "developer", content: "be brief" }, { role: "user", content: "hi" }] }))
    expect(request.input[0]).toEqual({ role: "system", content: "be brief" })
  })

  it("rejects unknown user content part types", () => {
    expect(err(lowerRequest({ messages: [{ role: "user", content: [{ type: "audio", audio: {} }] }] })).status).toBe(400)
  })
})
