import { describe, expect, it } from "vitest"
import { lowerRequest } from "../supabase/functions/muse-proxy/_lib/lower.ts"
import { encodeReasoningDetails, type ReasoningItem } from "../supabase/functions/muse-proxy/_lib/reasoning.ts"

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
    expect(request.tools).toHaveLength(11)
    expect(request.tool_choice).toBe("auto")
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

  it("always carries the opencode builtin tool set with client tools appended", () => {
    const request = ok(
      lowerRequest({
        messages: [],
        tools: [{ type: "function", function: { name: "echo", description: "echo it", parameters: { type: "object" } } }],
        tool_choice: "auto",
      }),
    )
    // Builtins first (fingerprint), client tools after.
    expect(request.tools?.at(-1)).toEqual({
      type: "function",
      name: "echo",
      description: "echo it",
      parameters: { type: "object" },
    })
    const names = request.tools!.map((t) => t.name)
    for (const builtin of ["bash", "edit", "glob", "grep", "read", "skill", "task", "todowrite", "webfetch", "websearch", "write"]) {
      expect(names).toContain(builtin)
    }
    expect(names.filter((n) => n === "echo")).toHaveLength(1)
    // tool_choice is forced to auto (upstream supports nothing else).
    expect(request.tool_choice).toBe("auto")
  })

  it("stubs builtin tool descriptions so the model cannot call unexecutable CLI tools", () => {
    const request = ok(lowerRequest({ messages: [] }))
    expect(request.tools).toHaveLength(11)
    for (const tool of request.tools!) {
      expect(tool.description).toBe("Reserved opencode CLI tool. Not available in this session; never call it.")
    }
  })

  it("lets client tools shadowing builtin names replace the stub entry in place", () => {
    const request = ok(
      lowerRequest({
        messages: [],
        tools: [{ type: "function", function: { name: "bash", description: "client bash", parameters: { type: "object" } } }],
      }),
    )
    const bash = request.tools!.filter((t) => t.name === "bash")
    expect(bash).toHaveLength(1)
    expect(bash[0]!.description).toBe("client bash")
    // Name set still carries the full builtin set, so the gate still passes.
    expect(request.tools).toHaveLength(11)
  })

  it("sets prompt_cache_key to the session id when provided", () => {
    const request = ok(lowerRequest({ messages: [] }, { sessionId: "ses_abc" }))
    expect(request.prompt_cache_key).toBe("ses_abc")
    const without = ok(lowerRequest({ messages: [] }))
    expect(without.prompt_cache_key).toBeUndefined()
  })

  it("defaults tool parameters when missing", () => {
    const request = ok(
      lowerRequest({
        messages: [],
        tools: [{ type: "function", function: { name: "noargs" } }],
      }),
    )
    const noargs = request.tools!.find((t) => t.name === "noargs")
    expect(noargs!.parameters).toEqual({ type: "object", properties: {} })
  })
})

describe("lowerRequest: encrypted reasoning replay", () => {
  const item = (id: string, enc: string, summary: string): ReasoningItem => ({
    id,
    summary,
    encrypted_content: enc,
  })

  it("drops reasoning_details replay (session-bound blobs rejected upstream)", () => {
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

  it("drops same-id fragments instead of merging (no replay upstream)", () => {
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

describe("lowerRequest: system array content", () => {
  it("accepts string system content as before", () => {
    const request = ok(lowerRequest({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] }))
    expect(request.input[0]).toEqual({ role: "system", content: "sys" })
  })

  it("accepts a single text part array", () => {
    const request = ok(
      lowerRequest({ messages: [{ role: "system", content: [{ type: "text", text: "hello" }] }, { role: "user", content: "hi" }] }),
    )
    expect(request.input[0]).toEqual({ role: "system", content: "hello" })
  })

  it("joins multiple text parts with newlines", () => {
    const request = ok(
      lowerRequest({
        messages: [{ role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, { role: "user", content: "hi" }],
      }),
    )
    expect(request.input[0]).toEqual({ role: "system", content: "a\nb" })
  })

  it("accepts input_text parts", () => {
    const request = ok(
      lowerRequest({ messages: [{ role: "system", content: [{ type: "input_text", text: "hello" }] }, { role: "user", content: "hi" }] }),
    )
    expect(request.input[0]).toEqual({ role: "system", content: "hello" })
  })

  it("rejects invalid system content with 400", () => {
    expect(err(lowerRequest({ messages: [{ role: "system", content: [{ type: "image_url", image_url: "x" }] }] })).status).toBe(400)
    expect(err(lowerRequest({ messages: [{ role: "system", content: [] }] })).status).toBe(400)
    expect(err(lowerRequest({ messages: [{ role: "system", content: 42 }] })).status).toBe(400)
  })
})
