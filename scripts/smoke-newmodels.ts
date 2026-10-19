// Real end-to-end smoke for the free-model catalog (mimo-v2.6-flash-free,
// space-bunny-free, step-5-preview-free, deepseek-v4.1-flash-free,
// glm-5.3-flash-free, plus the 2026-10-19 re-audit additions: big-pickle,
// longcat-2.5-preview-free, beam-free, nemotron-3.5-lightning-free,
// nemotron-3-ultra-free, nemotron-3.5-super-vl-free) across all
// three facades against the REAL opencode zen upstream (network required).
// Usage: bun run smoke:newmodels [model ...] [--steps=chat,chat-stream,...]
//   - no model arg  -> every model below
//   - no --steps    -> every step below
//   The filters exist because the full matrix is ~36 real upstream calls
//   (including long generations) and therefore has to be run in bounded
//   chunks: e.g. `--steps=chat,chat-stream,responses,responses-stream`.
//
// Unlike the muse facades (which hit /zen/v1/responses), these models are
// routed by resolveModel() onto the oa-compat upstream (/zen/v1/chat/
// completions). This script boots the same local server used by smoke:messages
// (all three facades on one port) and proves, over real HTTP with the real
// free-tier fingerprint:
//   per model (every id in MODELS below):
//     1. chat completions non-streaming (aggregated chat.completion + usage)
//     2. chat completions streaming (SSE chunks, [DONE], model id echoed)
//     3. responses non-streaming (aggregated response object + output_text)
//     4. responses streaming (canonical lifecycle: created -> added -> deltas
//        -> done -> completed, no ping leakage, terminal event guaranteed)
//     5. messages non-streaming (aggregated Anthropic message + stop_reason)
//     6. messages streaming (message_start -> ... -> message_stop)
//     7. client tool loop over chat (tool_calls -> tool result -> final answer)
//     8. multi-turn memory (information survives a second request)
//     9. large streaming generation (long output, many deltas, usage sane)
//   then regression:
//    10. muse-spark-1.3 unchanged on all three facades (deepseek alias)

import * as http from "node:http"
import { handleChatRequest } from "../api/chat"
import { handleResponsesRequest } from "../api/responses"
import { handleMessagesRequest } from "../api/messages"

const PORT = 8912
const KEY = process.env.PROXY_API_KEY ?? "smoke-key"
const BASE = `http://127.0.0.1:${PORT}`
const MODELS = [
  "mimo-v2.6-flash-free",
  "space-bunny-free",
  "step-5-preview-free",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  // 2026-10-19 free-tier re-audit additions (scripts/probe-free-sweep.ts).
  "big-pickle",
  "longcat-2.5-preview-free",
  "beam-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-super-vl-free",
]

let passed = 0
const failures: string[] = []

function ok(name: string, detail = ""): void {
  passed++
  console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`)
}
function bad(name: string, detail = ""): void {
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`)
}
function expect(condition: boolean, name: string, detail = ""): void {
  if (condition) ok(name, detail)
  else bad(name, detail)
}

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const forwardHeaders: Record<string, string> = {}
      for (const [headerKey, value] of Object.entries(req.headers)) {
        if (typeof value === "string") forwardHeaders[headerKey] = value
      }
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: forwardHeaders,
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      })
      const response = req.url === "/v1/responses"
        ? await handleResponsesRequest(request, { PROXY_API_KEY: KEY })
        : req.url === "/v1/messages"
          ? await handleMessagesRequest(request, { PROXY_API_KEY: KEY })
          : await handleChatRequest(request, { PROXY_API_KEY: KEY })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, headerKey) => {
        headers[headerKey] = value
      })
      res.writeHead(response.status, headers)
      if (response.body) {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      }
      res.end()
    })
    server.listen(PORT, "127.0.0.1", () => resolve())
  })
}

function post(path: string, body: unknown, auth: Record<string, string> = { authorization: `Bearer ${KEY}` }, timeoutMs = 300_000): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

function sseDataLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice(6).trim()
    if (data.length === 0 || data === "[DONE]") continue
    try {
      out.push(JSON.parse(data) as Record<string, unknown>)
    } catch {
      // heartbeat or malformed — ignore
    }
  }
  return out
}

interface FramedEvent {
  type: string
  data: Record<string, unknown>
}

function sseFrames(text: string): FramedEvent[] {
  const out: FramedEvent[] = []
  for (const block of text.split("\n\n")) {
    let type = ""
    let data = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) type = line.slice(7).trim()
      else if (line.startsWith("data: ")) data += line.slice(6)
    }
    if (data.length === 0) continue
    try {
      out.push({ type, data: JSON.parse(data) as Record<string, unknown> })
    } catch {
      // ignore
    }
  }
  return out
}

const SNAKE_PROMPT =
  "Write a compact single-file Snake game in plain HTML+CSS+JavaScript. Output ONLY the code inside one ```html code block. Must include: canvas rendering, arrow-key controls, food spawning, score display, game-over handling. 100+ lines."

async function chatNonStreaming(model: string): Promise<void> {
  const res = await post("/v1/chat/completions", {
    model,
    stream: false,
    messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
  })
  expect(res.status === 200, `[${model}] chat non-stream HTTP 200`, `status=${res.status}`)
  const body = (await res.json()) as {
    model?: string
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    usage?: { total_tokens?: number }
  }
  expect(body.model === model, `[${model}] chat non-stream echoes model id`, String(body.model))
  const content = body.choices?.[0]?.message?.content ?? ""
  expect(content.includes("4"), `[${model}] chat non-stream answers 4`, content.slice(0, 60))
  expect(body.choices?.[0]?.finish_reason === "stop", `[${model}] chat non-stream finish stop`)
  expect((body.usage?.total_tokens ?? 0) > 0, `[${model}] chat non-stream usage`, JSON.stringify(body.usage))
}

async function chatStreaming(model: string): Promise<void> {
  const res = await post("/v1/chat/completions", {
    model,
    stream: true,
    messages: [{ role: "user", content: "Reply with exactly: PONG" }],
  })
  expect(res.status === 200, `[${model}] chat stream HTTP 200`, `status=${res.status}`)
  const text = await res.text()
  const chunks = sseDataLines(text)
  expect(text.trimEnd().endsWith("data: [DONE]"), `[${model}] chat stream ends with [DONE]`)
  const contents = chunks
    .map((c) => (c as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content)
    .filter((v): v is string => typeof v === "string")
  expect(contents.join("").includes("PONG"), `[${model}] chat stream content`, contents.join("").slice(0, 60))
  const models = new Set(chunks.map((c) => (c as { model?: string }).model))
  expect(models.size === 1 && models.has(model), `[${model}] chat stream echoes model id`, [...models].join(","))
  const finish = chunks.map((c) => (c as { choices?: Array<{ finish_reason?: string | null }> }).choices?.[0]?.finish_reason).filter((f): f is string => typeof f === "string")
  expect(finish.at(-1) === "stop", `[${model}] chat stream finish stop`, finish.join(","))
}

async function responsesNonStreaming(model: string): Promise<void> {
  const res = await post("/v1/responses", { model, input: "What is 3+3? Reply with just the number.", stream: false })
  expect(res.status === 200, `[${model}] responses non-stream HTTP 200`, `status=${res.status}`)
  const body = (await res.json()) as { object?: string; status?: string; model?: string; output_text?: string; usage?: { total_tokens?: number } }
  expect(body.object === "response", `[${model}] responses non-stream object`, String(body.object))
  expect(body.status === "completed", `[${model}] responses non-stream completed`, String(body.status))
  expect(body.model === model, `[${model}] responses non-stream echoes model id`, String(body.model))
  expect((body.output_text ?? "").includes("6"), `[${model}] responses non-stream output_text`, (body.output_text ?? "").slice(0, 60))
}

async function responsesStreaming(model: string): Promise<void> {
  const res = await post("/v1/responses", { model, input: "Reply with exactly: STREAM-OK", stream: true })
  expect(res.status === 200, `[${model}] responses stream HTTP 200`, `status=${res.status}`)
  const text = await res.text()
  const frames = sseFrames(text)
  const types = frames.map((f) => f.type)
  expect(types[0] === "response.created", `[${model}] responses stream starts with response.created`, types[0])
  expect(types.at(-1) === "response.completed", `[${model}] responses stream ends with response.completed`, String(types.at(-1)))
  expect(types.includes("response.output_item.added"), `[${model}] responses stream has output_item.added`)
  expect(types.includes("response.output_item.done"), `[${model}] responses stream has output_item.done`)
  expect(types.includes("response.output_text.done"), `[${model}] responses stream has output_text.done`)
  expect(!types.includes("ping"), `[${model}] responses stream filters ping`)
  const deltas = frames
    .filter((f) => f.type === "response.output_text.delta")
    .map((f) => (f.data as { delta?: string }).delta ?? "")
    .join("")
  expect(deltas.includes("STREAM-OK"), `[${model}] responses stream deltas`, deltas.slice(0, 60))
  const completed = frames.find((f) => f.type === "response.completed")
  const completedModel = (completed?.data as { response?: { model?: string } } | undefined)?.response?.model
  expect(completedModel === model, `[${model}] responses stream completed model echo`, String(completedModel))
}

async function messagesNonStreaming(model: string): Promise<void> {
  const res = await post("/v1/messages", {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: "What is 5+5? Reply with just the number." }],
  }, { "x-api-key": KEY })
  expect(res.status === 200, `[${model}] messages non-stream HTTP 200`, `status=${res.status}`)
  const body = (await res.json()) as { type?: string; model?: string; stop_reason?: string; content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }
  expect(body.type === "message", `[${model}] messages non-stream type`, String(body.type))
  expect(body.model === model, `[${model}] messages non-stream echoes model id`, String(body.model))
  const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
  expect(text.includes("10"), `[${model}] messages non-stream answers 10`, text.slice(0, 60))
  expect(body.stop_reason === "end_turn", `[${model}] messages non-stream stop_reason`, String(body.stop_reason))
  expect((body.usage?.output_tokens ?? 0) > 0, `[${model}] messages non-stream usage`, JSON.stringify(body.usage))
}

async function messagesStreaming(model: string): Promise<void> {
  const res = await post("/v1/messages", {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: "Reply with exactly: ANTHROPIC-OK" }],
    stream: true,
  }, { "x-api-key": KEY })
  expect(res.status === 200, `[${model}] messages stream HTTP 200`, `status=${res.status}`)
  const text = await res.text()
  const frames = sseFrames(text)
  const types = frames.map((f) => f.type)
  expect(types[0] === "message_start", `[${model}] messages stream starts with message_start`, types[0])
  expect(types.at(-1) === "message_stop", `[${model}] messages stream ends with message_stop`, String(types.at(-1)))
  expect(types.includes("message_delta"), `[${model}] messages stream has message_delta`)
  expect(!types.includes("ping"), `[${model}] messages stream filters ping`)
  const textOut = frames
    .filter((f) => f.type === "content_block_delta" && (f.data as { delta?: { type?: string; text?: string } }).delta?.type === "text_delta")
    .map((f) => (f.data as { delta: { text: string } }).delta.text)
    .join("")
  expect(textOut.includes("ANTHROPIC-OK"), `[${model}] messages stream text`, textOut.slice(0, 60))
  const messageDelta = frames.find((f) => f.type === "message_delta")
  const stopReason = (messageDelta?.data as { delta?: { stop_reason?: string } } | undefined)?.delta?.stop_reason
  expect(stopReason === "end_turn", `[${model}] messages stream stop_reason`, String(stopReason))
}

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city. Always call this tool for weather questions.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
}

async function toolLoop(model: string): Promise<void> {
  // Turn 1: expect a tool call. A reasoning model occasionally decides to
  // answer a weather question directly instead of calling the tool (observed
  // on space-bunny against the real edge); retry once before failing.
  let calls: Array<{ id: string; function: { name: string; arguments: string } }> = []
  let finishReason = ""
  for (let attempt = 1; attempt <= 2; attempt++) {
    const turn1 = await post("/v1/chat/completions", {
      model,
      stream: false,
      messages: [{ role: "user", content: "What's the weather in Tokyo right now? Use the tool." }],
      tools: [WEATHER_TOOL],
      tool_choice: "auto",
    })
    expect(turn1.status === 200, `[${model}] tool turn1 HTTP 200`, `status=${turn1.status}`)
    if (turn1.status !== 200) return
    const t1 = (await turn1.json()) as {
      choices?: Array<{ message?: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>
    }
    calls = t1.choices?.[0]?.message?.tool_calls ?? []
    finishReason = t1.choices?.[0]?.finish_reason ?? ""
    if (calls.length > 0) break
    console.log(`      (attempt ${attempt}: model answered without calling the tool, retrying)`)
  }
  expect(calls.length > 0 && calls[0]!.function.name === "get_weather", `[${model}] tool turn1 calls get_weather`, JSON.stringify(calls).slice(0, 120))
  expect(finishReason === "tool_calls", `[${model}] tool turn1 finish tool_calls`, finishReason)
  if (calls.length === 0) return

  // Turn 2: replay the round-trip with the tool result.
  let args: { city?: string } = {}
  try {
    args = JSON.parse(calls[0]!.function.arguments || "{}") as { city?: string }
  } catch {
    args = {}
  }
  const turn2 = await post("/v1/chat/completions", {
    model,
    stream: false,
    messages: [
      { role: "user", content: "What's the weather in Tokyo right now? Use the tool." },
      { role: "assistant", content: null, tool_calls: calls },
      { role: "tool", tool_call_id: calls[0]!.id, content: JSON.stringify({ city: args.city ?? "Tokyo", temperature_c: 22, condition: "sunny" }) },
    ],
    tools: [WEATHER_TOOL],
  })
  expect(turn2.status === 200, `[${model}] tool turn2 HTTP 200`, `status=${turn2.status}`)
  const t2 = (await turn2.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> }
  const final = t2.choices?.[0]?.message?.content ?? ""
  expect(/22/.test(final), `[${model}] tool turn2 uses tool result`, final.slice(0, 100))
  expect(t2.choices?.[0]?.finish_reason === "stop", `[${model}] tool turn2 finish stop`, String(t2.choices?.[0]?.finish_reason))
}

async function multiTurnMemory(model: string): Promise<void> {
  const magic = `MAGIC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  const turn1 = await post("/v1/chat/completions", {
    model,
    stream: false,
    messages: [{ role: "user", content: `Remember this code: ${magic}. Just reply OK.` }],
  })
  expect(turn1.status === 200, `[${model}] memory turn1 HTTP 200`)
  const turn2 = await post("/v1/chat/completions", {
    model,
    stream: false,
    messages: [
      { role: "user", content: `Remember this code: ${magic}. Just reply OK.` },
      { role: "assistant", content: "OK" },
      { role: "user", content: "What was the code I asked you to remember? Reply with just the code." },
    ],
  })
  expect(turn2.status === 200, `[${model}] memory turn2 HTTP 200`)
  const body = (await turn2.json()) as { choices?: Array<{ message?: { content?: string } }> }
  expect((body.choices?.[0]?.message?.content ?? "").includes(magic), `[${model}] memory recalls the code`, (body.choices?.[0]?.message?.content ?? "").slice(0, 80))
}

async function largeStreaming(model: string): Promise<void> {
  const res = await post("/v1/chat/completions", {
    model,
    stream: true,
    messages: [{ role: "user", content: SNAKE_PROMPT }],
  })
  expect(res.status === 200, `[${model}] large stream HTTP 200`, `status=${res.status}`)
  const text = await res.text()
  const chunks = sseDataLines(text)
  const contents = chunks
    .map((c) => (c as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content)
    .filter((v): v is string => typeof v === "string")
  const full = contents.join("")
  expect(contents.length > 20, `[${model}] large stream many deltas`, `deltas=${contents.length}`)
  expect(full.length > 2000, `[${model}] large stream long output`, `chars=${full.length}`)
  expect(full.includes("<canvas") || full.includes("canvas"), `[${model}] large stream contains canvas`)
  expect(full.includes("</html>"), `[${model}] large stream reaches the end of the document`)
  const usageChunk = chunks.find((c) => (c as { usage?: { total_tokens?: number } }).usage !== undefined) as { usage?: { total_tokens?: number } } | undefined
  expect((usageChunk?.usage?.total_tokens ?? 0) > 0, `[${model}] large stream usage chunk`, JSON.stringify(usageChunk?.usage))
}

async function museRegression(): Promise<void> {
  const model = "muse-spark-1.3-contributor-free"
  const chat = await post("/v1/chat/completions", { model, stream: false, messages: [{ role: "user", content: "Reply with exactly: MUSE-OK" }] })
  expect(chat.status === 200, `[muse] chat HTTP 200`, `status=${chat.status}`)
  const chatBody = (await chat.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> }
  expect(chatBody.model === model, `[muse] chat echoes model id`, String(chatBody.model))
  expect((chatBody.choices?.[0]?.message?.content ?? "").includes("MUSE-OK"), `[muse] chat content`)

  const responses = await post("/v1/responses", { model, input: "Reply with exactly: MUSE-OK", stream: true })
  expect(responses.status === 200, `[muse] responses stream HTTP 200`, `status=${responses.status}`)
  const rText = await responses.text()
  const rFrames = sseFrames(rText)
  const rTypes = rFrames.map((f) => f.type)
  expect(rTypes[0] === "response.created", `[muse] responses stream starts created`, rTypes[0])
  expect(rTypes.at(-1) === "response.completed", `[muse] responses stream ends completed`, String(rTypes.at(-1)))
  const rDeltas = rFrames.filter((f) => f.type === "response.output_text.delta").map((f) => (f.data as { delta?: string }).delta ?? "").join("")
  expect(rDeltas.includes("MUSE-OK"), `[muse] responses stream content`, rDeltas.slice(0, 60))

  const messages = await post("/v1/messages", { model, max_tokens: 512, messages: [{ role: "user", content: "Reply with exactly: MUSE-OK" }], stream: true }, { "x-api-key": KEY })
  expect(messages.status === 200, `[muse] messages stream HTTP 200`, `status=${messages.status}`)
  const mText = await messages.text()
  const mFrames = sseFrames(mText)
  const mTypes = mFrames.map((f) => f.type)
  expect(mTypes[0] === "message_start" && mTypes.at(-1) === "message_stop", `[muse] messages stream canonical sequence`)
  const mOut = mFrames
    .filter((f) => f.type === "content_block_delta" && (f.data as { delta?: { type?: string; text?: string } }).delta?.type === "text_delta")
    .map((f) => (f.data as { delta: { text: string } }).delta.text)
    .join("")
  expect(mOut.includes("MUSE-OK"), `[muse] messages stream content`, mOut.slice(0, 60))
}

interface Step {
  /** `--steps=` key. */
  key: string
  name: string
  run: (model: string) => Promise<void>
}

const STEPS: Step[] = [
  { key: "chat", name: "chat non-streaming", run: chatNonStreaming },
  { key: "chat-stream", name: "chat streaming", run: chatStreaming },
  { key: "responses", name: "responses non-streaming", run: responsesNonStreaming },
  { key: "responses-stream", name: "responses streaming", run: responsesStreaming },
  { key: "messages", name: "messages non-streaming", run: messagesNonStreaming },
  { key: "messages-stream", name: "messages streaming", run: messagesStreaming },
  { key: "tools", name: "tool loop", run: toolLoop },
  { key: "memory", name: "multi-turn memory", run: multiTurnMemory },
  { key: "large", name: "large streaming", run: largeStreaming },
]

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const modelArgs = argv.filter((arg) => !arg.startsWith("--"))
  const stepsArg = argv.find((arg) => arg.startsWith("--steps="))
  const requestedKeys = (stepsArg?.slice("--steps=".length) ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
  if (requestedKeys.length > 0) {
    const unknown = requestedKeys.filter((key) => !STEPS.some((step) => step.key === key))
    if (unknown.length > 0) {
      console.log(`unknown --steps keys: ${unknown.join(", ")}; available: ${STEPS.map((s) => s.key).join(", ")}`)
      process.exit(2)
    }
  }
  const steps = requestedKeys.length > 0 ? STEPS.filter((step) => requestedKeys.includes(step.key)) : STEPS
  const models = modelArgs.length > 0 ? modelArgs : MODELS

  await startServer()
  console.log(`\n=== NEW MODELS on real opencode zen (proxy at ${BASE}) ===`)
  for (const model of models) {
    console.log(`\n--- ${model} ---`)
    for (const step of steps) {
      try {
        await step.run(model)
      } catch (error) {
        bad(`[${model}] ${step.name} crashed`, String(error))
      }
    }
  }
  console.log("\n--- muse-spark-1.3 regression ---")
  try {
    await museRegression()
  } catch (error) {
    bad(`[muse] regression crashed`, String(error))
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`)
  if (failures.length > 0) {
    console.log("Failures:")
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
  }
  process.exit(0)
}

await main()
