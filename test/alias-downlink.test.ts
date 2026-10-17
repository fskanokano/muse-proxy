// Downlink alias round-trip. The upstream gate rejects any client tool whose
// name is reserved (the 12 builtins plus the retired bash/task/todowrite), so
// those travel as `mp_<name>` (see tools.ts). Every facade must map the call
// back to the name the client declared - the client must never see `mp_`.
// Upstream mock: oa-compat chat-completions frames (the only wire now, muse
// included).
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleChatRequest } from "../api/chat"
import { handleMessagesRequest } from "../api/messages"
import { handleResponsesRequest } from "../api/responses"

type EchoedTool = { name: string; description?: string }

const ENV = { PROXY_API_KEY: "test-key" }
const SHELL_PARAMS = {
  type: "object",
  properties: { command: { type: "string", description: "shell command to run" } },
  required: ["command"],
}

let originalFetch: typeof fetch
let calls: Array<{ url: string; init?: RequestInit }> = []

beforeEach(() => {
  calls = []
  originalFetch = globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

function sse(events: Array<Record<string, unknown>>): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function mockUpstream(events: Array<Record<string, unknown>>): void {
  const response = sse(events)
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return response
  }) as typeof fetch
}

function toolCallEvent(name: string, args: string, id = "call_1"): Record<string, unknown> {
  return { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] } }] }
}

function finishEvent(reason: string): Record<string, unknown> {
  return { choices: [{ index: 0, delta: {}, finish_reason: reason }] }
}

function postMessages(body: unknown): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: JSON.stringify(body),
  })
}

function postResponses(body: unknown): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-key" },
    body: JSON.stringify(body),
  })
}

function postChat(body: unknown): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-key" },
    body: JSON.stringify(body),
  })
}

describe("chat facade: mp_ round-trip", () => {
  it("maps an upstream mp_shell call back to the client's own `shell`", async () => {
    mockUpstream([
      toolCallEvent("mp_shell", '{"command":"ls"}'),
      finishEvent("tool_calls"),
    ])

    const res = await handleChatRequest(
      postChat({
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        tools: [{ type: "function", function: { name: "shell", description: "client shell", parameters: SHELL_PARAMS } }],
      }),
      ENV,
    )

    const text = await res.text()
    expect(text).toContain('"name":"shell"')
    expect(text).not.toContain("mp_shell")
    expect(calls[0]!.url).toBe("https://opencode.ai/inference/openai/v1/chat/completions")
  })
})

describe("messages facade: mp_ round-trip", () => {
  it("maps an upstream mp_shell call back to the client's own `shell`", async () => {
    mockUpstream([
      toolCallEvent("mp_shell", '{"command":"ls"}'),
      finishEvent("tool_calls"),
    ])

    const res = await handleMessagesRequest(
      postMessages({
        model: "claude-3-5-sonnet",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "shell", description: "client shell", input_schema: SHELL_PARAMS }],
      }),
      ENV,
    )

    const text = await res.text()
    expect(text).toContain('"name":"shell"')
    expect(text).not.toContain("mp_shell")
  })
})

describe("responses facade: mp_ round-trip", () => {
  it("maps an upstream mp_shell call back to the client's own `shell`", async () => {
    mockUpstream([
      toolCallEvent("mp_shell", '{"command":"ls"}'),
      finishEvent("tool_calls"),
    ])

    const res = await handleResponsesRequest(
      postResponses({
        input: "hi",
        stream: true,
        tools: [{ type: "function", name: "shell", description: "client shell", parameters: SHELL_PARAMS }],
      }),
      ENV,
    )

    const text = await res.text()
    // The Responses facade must still expose the canonical accumulators'
    // contract: added/done items carry the client's own name, and the
    // arguments delta travels in full.
    expect(text).toContain('"type":"function_call"')
    expect(text).toContain('"name":"shell"')
    expect(text).toContain('response.function_call_arguments.delta')
    expect(text).not.toContain("mp_shell")
    const argsDone = text
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((block) => JSON.parse(block.split("\n")[1]!.slice("data: ".length)) as Record<string, unknown>)
      .find((event) => event.type === "response.function_call_arguments.done") as { arguments: string } | undefined
    expect(argsDone?.arguments).toBe('{"command":"ls"}')
  })

  it("exposes the raised function-call lifecycle in Responses accumulator order", async () => {
    mockUpstream([
      toolCallEvent("shell", '{"command":"ls"}'),
      finishEvent("tool_calls"),
    ])

    const res = await handleResponsesRequest(
      postResponses({
        input: "hi",
        stream: true,
        tools: [
          { type: "function", name: "shell", description: "client shell", parameters: SHELL_PARAMS },
          { type: "function", name: "my_tool", description: "mine", parameters: { type: "object", properties: {} } },
        ],
      }),
      ENV,
    )

    const frames = (await res.text())
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((block) => JSON.parse(block.split("\n")[1]!.slice("data: ".length)) as Record<string, unknown>)

    // The oa-compat raiser re-implements the muse Responses SSE的 canonical
    // order: added -> arguments delta -> arguments done -> item done, with the
    // client's declared description preserved on the echoed item.
    const added = frames.filter((event) => event.type === "response.output_item.added")
    const argsDone = frames.filter((event) => event.type === "response.function_call_arguments.done")
    const itemDone = frames.filter((event) => event.type === "response.output_item.done")
    expect(added).toHaveLength(1)
    expect(argsDone).toHaveLength(1)
    expect(itemDone).toHaveLength(1)
    const raisedItem = (added[0] as unknown as { item: EchoedTool }).item
    expect(raisedItem.name).toBe("shell")
  })
})
