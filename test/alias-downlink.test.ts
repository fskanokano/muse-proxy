// Downlink alias round-trip. The upstream gate rejects any client tool whose
// name is reserved (the 12 builtins plus the retired bash/task/todowrite), so
// those travel as `mp_<name>` (see tools.ts). Every facade must map the call
// back to the name the client declared - the client must never see `mp_`.
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
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "mp_shell", arguments: '{"command":"ls"}' } },
      { type: "response.completed", response: {} },
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
  })
})

describe("messages facade: mp_ round-trip", () => {
  it("maps an upstream mp_shell call back to the client's own `shell`", async () => {
    mockUpstream([
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "mp_shell", arguments: '{"command":"ls"}' } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
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
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_1", type: "function_call", status: "in_progress", name: "mp_shell", call_id: "call_1", arguments: "" },
      },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: '{"command":"ls"}', name: "mp_shell" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "fc_1", type: "function_call", status: "completed", name: "mp_shell", call_id: "call_1", arguments: '{"command":"ls"}' },
      },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
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
    expect(text).toContain('"name":"shell"')
    expect(text).not.toContain("mp_shell")
  })

  it("echoes only the client's own tools, under their original names", async () => {
    const echoed = [
      { type: "function", name: "shell", description: "builtin shell" },
      { type: "function", name: "mp_shell", description: "client shell" },
      { type: "function", name: "my_tool", description: "mine" },
    ]
    mockUpstream([
      { type: "response.created", response: { id: "resp_1", tools: echoed } },
      { type: "response.completed", response: { tools: echoed, usage: { input_tokens: 1, output_tokens: 1 } } },
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
      .map((event) => (event.response as { tools?: EchoedTool[] } | undefined)?.tools)
      .filter((tools): tools is EchoedTool[] => Array.isArray(tools))

    expect(frames).toHaveLength(2)
    for (const tools of frames) {
      // The injected builtin is dropped and the aliased client tool keeps the
      // name the client declared.
      expect(tools.map((tool) => tool.name)).toEqual(["shell", "my_tool"])
      expect(tools[0]!.description).toBe("client shell")
    }
  })
})
