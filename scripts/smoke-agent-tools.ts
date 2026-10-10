// Real-upstream agent tool-loop smoke: proves a third-party agent can drive
// EVERY model through EVERY facade with a real streaming tool-call round-trip
// (network required). Usage: bun run smoke:tools
//
// What an external agent does on the wire, and what this script replays:
//   chat facade:  delta.tool_calls (streamed args) -> finish tool_calls ->
//                 harness executes the tool -> assistant tool_calls message +
//                 role:"tool" result -> final answer (finish stop)
//   responses:    response.output_item.done {type:"function_call"} ->
//                 harness executes -> replay input as {type:"function_call"}
//                 + {type:"function_call_output"} -> final output_text
//   messages:     content_block_start tool_use + input_json_delta ->
//                 stop_reason tool_use -> harness executes -> replay as
//                 tool_use block + tool_result block -> final text block
//
// Per model (muse / mimo / space-bunny / step-5) and per facade the script
// asserts:
//   1. streaming is real (chunks arrive incrementally over time)
//   2. the model issues a tool call for the CLIENT tool (not a builtin)
//   3. the streamed tool arguments parse as JSON
//   4. the replayed turn completes with a grounded final answer carrying the
//      tool-result sentinel (proves the result actually reached the model)
//   5. the canonical finish signal (stop / response.completed / end_turn)
//
// Grounding uses a deterministic local tool with a sentinel value, so the
// final answer can only contain it if the round-trip worked end to end.

import * as http from "node:http"
import { handleChatRequest } from "../api/chat"
import { handleResponsesRequest } from "../api/responses"
import { handleMessagesRequest } from "../api/messages"

const PORT = 8914
const KEY = process.env.PROXY_API_KEY ?? "smoke-key"
const BASE = `http://127.0.0.1:${PORT}`
const MODELS = ["muse-spark-1.3-contributor-free", "mimo-v2.6-flash-free", "space-bunny-free", "step-5-preview-free"]

let passed = 0
const failures: string[] = []

function ok(name: string, detail = ""): void {
  passed++
  console.log(`    PASS ${name}${detail ? ` — ${detail}` : ""}`)
}
function bad(name: string, detail = ""): void {
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
  console.log(`    FAIL ${name}${detail ? ` — ${detail}` : ""}`)
}
function expect(condition: boolean, name: string, detail = ""): void {
  if (condition) ok(name, detail)
  else bad(name, detail)
}

// ---------------------------------------------------------------------------
// Local server exposing all three facades on one port (same shape as the
// other smokes; upstream fetches stay real).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Deterministic local tool + harness execution
// ---------------------------------------------------------------------------

const CITY_TOOL = {
  name: "get_city_report",
  description: "Look up the city report for a given city. Always call this tool for city questions.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
}
const CITY_TOOL_CHAT = { type: "function", function: CITY_TOOL }
const SENTINEL = `SX-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

function executeCityTool(argumentsJson: string): string {
  let city = "Tokyo"
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { city?: string }
    if (typeof parsed.city === "string" && parsed.city.length > 0) city = parsed.city
  } catch {
    // keep default
  }
  return JSON.stringify({ city, temperature_c: 17, condition: "cloudy", report_id: SENTINEL })
}

// ---------------------------------------------------------------------------
// Shared streaming helpers: read the SSE body incrementally so we can prove
// chunks arrive over time (真流式), like a real agent SDK would.
// ---------------------------------------------------------------------------

interface StreamTiming {
  firstChunkMs: number | null
  lastChunkMs: number | null
  readCount: number
}

async function readBodyIncrementally(
  res: Response,
  onText: (text: string) => void,
): Promise<StreamTiming> {
  const decoder = new TextDecoder()
  const reader = res.body!.getReader()
  const timing: StreamTiming = { firstChunkMs: null, lastChunkMs: null, readCount: 0 }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const now = Date.now()
    if (timing.firstChunkMs === null) timing.firstChunkMs = now
    timing.lastChunkMs = now
    timing.readCount++
    onText(decoder.decode(value, { stream: true }))
  }
  return timing
}

/** OpenAI-style data: lines (chat facade). */
function parseDataLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice(6).trim()
    if (data.length === 0 || data === "[DONE]") continue
    try {
      out.push(JSON.parse(data) as Record<string, unknown>)
    } catch {
      // heartbeat comments / partial lines
    }
  }
  return out
}

/** event:-framed SSE (responses + messages facades). */
function parseFrames(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  const out: Array<{ type: string; data: Record<string, unknown> }> = []
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

function post(path: string, body: unknown, auth: Record<string, string> = { authorization: `Bearer ${KEY}` }, timeoutMs = 300_000): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

const USER_ASK = "What is the weather report for Tokyo right now? Use the get_city_report tool, then tell me the temperature and the report id."
const BUILTIN_TOOL_NAMES = new Set(["bash", "edit", "glob", "grep", "read", "skill", "task", "todowrite", "webfetch", "websearch", "write"])

// ---------------------------------------------------------------------------
// 1) Chat facade streaming tool loop
// ---------------------------------------------------------------------------

async function chatToolLoop(model: string): Promise<void> {
  const tools = [CITY_TOOL_CHAT]

  // Turn 1: streamed tool call.
  const res1 = await post("/v1/chat/completions", {
    model,
    stream: true,
    messages: [{ role: "user", content: USER_ASK }],
    tools,
    tool_choice: "auto",
  })
  expect(res1.status === 200, `[${model}] chat turn1 HTTP 200`, `status=${res1.status}`)
  if (res1.status !== 200) {
    console.log(`      body: ${(await res1.text()).slice(0, 200)}`)
    return
  }

  // Real incremental streaming: parse per read() instead of awaiting text().
  const sse1 = { text: "" }
  const timing1 = await readBodyIncrementally(res1, (text) => {
    sse1.text += text
  })
  expect(timing1.firstChunkMs !== null && timing1.lastChunkMs !== null && timing1.lastChunkMs - timing1.firstChunkMs > 0, `[${model}] chat turn1 真流式 (chunks arrive over time)`, `${timing1.readCount} reads, span=${timing1.lastChunkMs! - timing1.firstChunkMs!}ms`)

  const chunks1 = parseDataLines(sse1.text)
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
  let finish1 = ""
  for (const chunk of chunks1) {
    const c = chunk as { choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }> }
    for (const call of c.choices?.[0]?.delta?.tool_calls ?? []) {
      if (call.id && call.function?.name) {
        toolCalls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments ?? "" })
      } else if (call.function?.arguments && toolCalls.length > 0) {
        toolCalls[toolCalls.length - 1]!.arguments += call.function.arguments
      }
    }
    if (typeof c.choices?.[0]?.finish_reason === "string") finish1 = c.choices[0].finish_reason
  }
  expect(toolCalls.length > 0, `[${model}] chat turn1 issued a tool call`, toolCalls.map((c) => c.name).join(","))
  const cityCall = toolCalls.find((c) => c.name === "get_city_report")
  expect(cityCall !== undefined, `[${model}] chat turn1 calls the CLIENT tool get_city_report`)
  expect(cityCall === undefined || !BUILTIN_TOOL_NAMES.has(cityCall.name), `[${model}] chat turn1 no builtin (stubbed) tool call leaked`)
  let args1 = ""
  if (cityCall) {
    try {
      const parsed = JSON.parse(cityCall.arguments || "{}") as { city?: string }
      args1 = typeof parsed.city === "string" ? parsed.city : ""
      expect(true, `[${model}] chat turn1 tool arguments are valid JSON`, cityCall.arguments.slice(0, 60))
    } catch (error) {
      expect(false, `[${model}] chat turn1 tool arguments are valid JSON`, String(error))
    }
  }
  expect(finish1 === "tool_calls", `[${model}] chat turn1 finish_reason=tool_calls`, finish1)

  // Turn 2: replay with the tool result; expect a grounded final answer.
  const toolResult = executeCityTool(cityCall?.arguments ?? "{}")
  const res2 = await post("/v1/chat/completions", {
    model,
    stream: true,
    messages: [
      { role: "user", content: USER_ASK },
      { role: "assistant", content: null, tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) },
      { role: "tool", tool_call_id: cityCall?.id ?? toolCalls[0]?.id ?? "call_unknown", content: toolResult },
    ],
    tools,
  })
  expect(res2.status === 200, `[${model}] chat turn2 HTTP 200`, `status=${res2.status}`)
  if (res2.status !== 200) {
    console.log(`      body: ${(await res2.text()).slice(0, 200)}`)
    return
  }
  const sse2 = { text: "" }
  const timing2 = await readBodyIncrementally(res2, (text) => {
    sse2.text += text
  })
  const chunks2 = parseDataLines(sse2.text)
  let content2 = ""
  let finish2 = ""
  for (const chunk of chunks2) {
    const c = chunk as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> }
    content2 += c.choices?.[0]?.delta?.content ?? ""
    if (typeof c.choices?.[0]?.finish_reason === "string") finish2 = c.choices[0].finish_reason
  }
  expect(timing2.firstChunkMs !== null && timing2.lastChunkMs !== null && timing2.lastChunkMs - timing2.firstChunkMs > 0, `[${model}] chat turn2 真流式`, `${timing2.readCount} reads`)
  expect(finish2 === "stop", `[${model}] chat turn2 finish_reason=stop`, finish2)
  expect(content2.includes("17"), `[${model}] chat turn2 uses the tool result (temperature 17)`, content2.slice(0, 90).replace(/\n/g, " "))
  expect(content2.includes(SENTINEL), `[${model}] chat turn2 grounded on the sentinel ${SENTINEL}`, content2.slice(0, 90).replace(/\n/g, " "))
  expect(args1.length > 0, `[${model}] chat turn1 extracted city argument`, args1)
}

// ---------------------------------------------------------------------------
// 2) Responses facade streaming tool loop
// ---------------------------------------------------------------------------

async function responsesToolLoop(model: string): Promise<void> {
  const tools = [{ type: "function", name: CITY_TOOL.name, description: CITY_TOOL.description, parameters: CITY_TOOL.parameters }]

  // Turn 1: streamed function_call item.
  const res1 = await post("/v1/responses", {
    model,
    input: USER_ASK,
    tools,
    stream: true,
  })
  expect(res1.status === 200, `[${model}] responses turn1 HTTP 200`, `status=${res1.status}`)
  if (res1.status !== 200) {
    console.log(`      body: ${(await res1.text()).slice(0, 200)}`)
    return
  }
  const sse1 = { text: "" }
  const timing1 = await readBodyIncrementally(res1, (text) => {
    sse1.text += text
  })
  expect(timing1.firstChunkMs !== null && timing1.lastChunkMs !== null && timing1.lastChunkMs - timing1.firstChunkMs > 0, `[${model}] responses turn1 真流式`, `${timing1.readCount} reads`)

  const frames1 = parseFrames(sse1.text)
  const types1 = frames1.map((f) => f.type)
  expect(types1.at(-1) === "response.completed", `[${model}] responses turn1 ends with response.completed`, String(types1.at(-1)))
  const callItem = frames1
    .filter((f) => f.type === "response.output_item.done")
    .map((f) => f.data.item as { type?: string; call_id?: string; id?: string; name?: string; arguments?: string } | undefined)
    .find((item) => item?.type === "function_call")
  expect(callItem !== undefined, `[${model}] responses turn1 emitted a function_call item`)
  expect(callItem !== undefined && callItem.name === "get_city_report", `[${model}] responses turn1 calls the CLIENT tool get_city_report`, callItem?.name)
  expect(callItem === undefined || !BUILTIN_TOOL_NAMES.has(callItem.name ?? ""), `[${model}] responses turn1 no builtin (stubbed) tool call leaked`)
  let argsOk = false
  let argsCity = ""
  if (callItem) {
    try {
      const parsed = JSON.parse(callItem.arguments || "{}") as { city?: string }
      argsCity = typeof parsed.city === "string" ? parsed.city : ""
      argsOk = true
      expect(true, `[${model}] responses turn1 function_call arguments are valid JSON`, (callItem.arguments ?? "").slice(0, 60))
    } catch (error) {
      expect(false, `[${model}] responses turn1 function_call arguments are valid JSON`, String(error))
    }
  }

  // Turn 2: replay as function_call + function_call_output input items.
  const toolResult = executeCityTool(callItem?.arguments ?? "{}")
  const callId = callItem?.call_id ?? callItem?.id ?? "call_unknown"
  const res2 = await post("/v1/responses", {
    model,
    input: [
      { role: "user", content: USER_ASK },
      { type: "function_call", call_id: callId, name: "get_city_report", arguments: callItem?.arguments ?? "{}" },
      { type: "function_call_output", call_id: callId, output: toolResult },
    ],
    tools,
    stream: true,
  })
  expect(res2.status === 200, `[${model}] responses turn2 HTTP 200`, `status=${res2.status}`)
  if (res2.status !== 200) {
    console.log(`      body: ${(await res2.text()).slice(0, 200)}`)
    return
  }
  const sse2 = { text: "" }
  const timing2 = await readBodyIncrementally(res2, (text) => {
    sse2.text += text
  })
  const frames2 = parseFrames(sse2.text)
  const types2 = frames2.map((f) => f.type)
  const outputText = frames2
    .filter((f) => f.type === "response.output_text.delta")
    .map((f) => (f.data as { delta?: string }).delta ?? "")
    .join("")
  expect(timing2.firstChunkMs !== null && timing2.lastChunkMs !== null && timing2.lastChunkMs - timing2.firstChunkMs > 0, `[${model}] responses turn2 真流式`, `${timing2.readCount} reads`)
  expect(types2.at(-1) === "response.completed", `[${model}] responses turn2 ends with response.completed`, String(types2.at(-1)))
  expect(outputText.includes("17"), `[${model}] responses turn2 uses the tool result (temperature 17)`, outputText.slice(0, 90).replace(/\n/g, " "))
  expect(outputText.includes(SENTINEL), `[${model}] responses turn2 grounded on the sentinel ${SENTINEL}`, outputText.slice(0, 90).replace(/\n/g, " "))
  expect(argsOk, `[${model}] responses turn1 extracted city argument`, argsCity)
}

// ---------------------------------------------------------------------------
// 3) Messages facade streaming tool loop
// ---------------------------------------------------------------------------

async function messagesToolLoop(model: string): Promise<void> {
  const tools = [{ name: CITY_TOOL.name, description: CITY_TOOL.description, input_schema: CITY_TOOL.parameters }]

  // Turn 1: streamed tool_use block + stop_reason tool_use.
  const res1 = await post(
    "/v1/messages",
    { model, max_tokens: 1024, messages: [{ role: "user", content: USER_ASK }], tools, stream: true },
    { "x-api-key": KEY },
  )
  expect(res1.status === 200, `[${model}] messages turn1 HTTP 200`, `status=${res1.status}`)
  if (res1.status !== 200) {
    console.log(`      body: ${(await res1.text()).slice(0, 200)}`)
    return
  }
  const sse1 = { text: "" }
  const timing1 = await readBodyIncrementally(res1, (text) => {
    sse1.text += text
  })
  expect(timing1.firstChunkMs !== null && timing1.lastChunkMs !== null && timing1.lastChunkMs - timing1.firstChunkMs > 0, `[${model}] messages turn1 真流式`, `${timing1.readCount} reads`)

  const frames1 = parseFrames(sse1.text)
  const types1 = frames1.map((f) => f.type)
  expect(types1[0] === "message_start", `[${model}] messages turn1 starts with message_start`, types1[0])
  expect(types1.at(-1) === "message_stop", `[${model}] messages turn1 ends with message_stop`, String(types1.at(-1)))
  const toolUseStart = frames1.find((f) => f.type === "content_block_start" && (f.data as { content_block?: { type?: string; name?: string } }).content_block?.type === "tool_use")
  const toolBlock = (toolUseStart?.data as { content_block?: { id?: string; name?: string } } | undefined)?.content_block
  expect(toolBlock !== undefined && toolBlock.name === "get_city_report", `[${model}] messages turn1 emits a tool_use block for the CLIENT tool`, toolBlock?.name)
  expect(toolBlock === undefined || !BUILTIN_TOOL_NAMES.has(toolBlock.name ?? ""), `[${model}] messages turn1 no builtin (stubbed) tool call leaked`)
  const partialJson = frames1
    .filter((f) => f.type === "content_block_delta" && (f.data as { delta?: { type?: string; partial_json?: string } }).delta?.type === "input_json_delta")
    .map((f) => (f.data as { delta: { partial_json: string } }).delta.partial_json)
    .join("")
  expect(partialJson.length > 0, `[${model}] messages turn1 streamed input_json_delta`, partialJson.slice(0, 60))
  let argsOk = false
  let argsCity = ""
  if (partialJson.length > 0) {
    try {
      const parsed = JSON.parse(partialJson || "{}") as { city?: string }
      argsCity = typeof parsed.city === "string" ? parsed.city : ""
      argsOk = true
    } catch {
      argsOk = false
    }
  }
  expect(argsOk, `[${model}] messages turn1 input_json_delta parses as JSON`, partialJson.slice(0, 60))
  const stopReason1 = frames1
    .filter((f) => f.type === "message_delta")
    .map((f) => (f.data as { delta?: { stop_reason?: string } }).delta?.stop_reason)
    .at(-1)
  expect(stopReason1 === "tool_use", `[${model}] messages turn1 stop_reason=tool_use`, String(stopReason1))

  // Turn 2: replay as tool_use block (assistant) + tool_result block (user).
  const toolResult = executeCityTool(partialJson || "{}")
  const res2 = await post(
    "/v1/messages",
    {
      model,
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: "user", content: USER_ASK },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: toolBlock?.id ?? "toolu_unknown", name: "get_city_report", input: argsOk ? JSON.parse(partialJson || "{}") : {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: toolBlock?.id ?? "toolu_unknown", content: toolResult },
            { type: "text", text: "Based on the tool result, tell me the temperature and the report id." },
          ],
        },
      ],
      tools,
    },
    { "x-api-key": KEY },
  )
  expect(res2.status === 200, `[${model}] messages turn2 HTTP 200`, `status=${res2.status}`)
  if (res2.status !== 200) {
    console.log(`      body: ${(await res2.text()).slice(0, 200)}`)
    return
  }
  const sse2 = { text: "" }
  const timing2 = await readBodyIncrementally(res2, (text) => {
    sse2.text += text
  })
  const frames2 = parseFrames(sse2.text)
  const text2 = frames2
    .filter((f) => f.type === "content_block_delta" && (f.data as { delta?: { type?: string; text?: string } }).delta?.type === "text_delta")
    .map((f) => (f.data as { delta: { text: string } }).delta.text)
    .join("")
  const stopReason2 = frames2
    .filter((f) => f.type === "message_delta")
    .map((f) => (f.data as { delta?: { stop_reason?: string } }).delta?.stop_reason)
    .at(-1)
  expect(timing2.firstChunkMs !== null && timing2.lastChunkMs !== null && timing2.lastChunkMs - timing2.firstChunkMs > 0, `[${model}] messages turn2 真流式`, `${timing2.readCount} reads`)
  expect(stopReason2 === "end_turn", `[${model}] messages turn2 stop_reason=end_turn`, String(stopReason2))
  expect(text2.includes("17"), `[${model}] messages turn2 uses the tool result (temperature 17)`, text2.slice(0, 90).replace(/\n/g, " "))
  expect(text2.includes(SENTINEL), `[${model}] messages turn2 grounded on the sentinel ${SENTINEL}`, text2.slice(0, 90).replace(/\n/g, " "))
  expect(argsCity.length > 0, `[${model}] messages turn1 extracted city argument`, argsCity)
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await startServer()
  console.log(`\n=== AGENT TOOL-LOOP SMOKE on real opencode zen (proxy at ${BASE}, sentinel ${SENTINEL}) ===`)
  // A reasoning model occasionally skips the tool call and answers directly
  // (observed on space-bunny against the real edge). Run each facade loop
  // with one free retry: roll the counters back and try again before
  // letting a model-side skip fail the suite.
  async function runWithRetry(name: string, fn: () => Promise<void>): Promise<void> {
    const passedBefore = passed
    const failuresBefore = failures.length
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) {
        passed = passedBefore
        failures.length = failuresBefore
        console.log(`  [${name}] retrying once (model may have skipped the tool call)`)
      }
      try {
        await fn()
      } catch (error) {
        bad(`[${name}] crashed`, String(error))
      }
      if (failures.length === failuresBefore) return
    }
  }
  for (const model of MODELS) {
    console.log(`\n--- ${model} ---`)
    const loops: Array<[string, () => Promise<void>]> = [
      ["chat streaming tool loop", () => chatToolLoop(model)],
      ["responses streaming tool loop", () => responsesToolLoop(model)],
      ["messages streaming tool loop", () => messagesToolLoop(model)],
    ]
    for (const [name, fn] of loops) {
      console.log(`  [${name}]`)
      await runWithRetry(name, fn)
    }
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
