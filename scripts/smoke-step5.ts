// Real end-to-end smoke for step-5-preview-free ONLY (network required).
// Usage: bun run smoke:step5
//
// step-5-preview-free is the fourth free zen model (added 2026-10-10). It
// routes through the oa-compat upstream (/zen/v1/chat/completions) exactly
// like mimo / space-bunny, so every facade, tool loop and clamp works over
// the shared converter — this script proves that against the REAL edge and
// additionally pins down step-5's own surface:
//   1. /v1/models catalog entry (id, reasoning, levels minimal..max, limits)
//   2. alias routing (step5 / Step-5-Preview-Free -> canonical id)
//   3. chat non-streaming + streaming
//   4. responses non-streaming + streaming (canonical lifecycle)
//   5. messages non-streaming + streaming (canonical sequence)
//   6. reasoning streams on all three facades (reasoning_content /
//      response.reasoning_text.delta / thinking_delta), with retries because
//      a reasoning model MAY stay silent on a trivial prompt
//   7. chat tool loop with grounding (streamed tool_calls -> result -> answer)
//   8. parallel tool calls replayed merged in ONE assistant message
//   9. reasoning efforts none (clamped) / minimal / high / max each complete
//  10. multi-turn memory
//  11. large streaming generation with a sane usage chunk
//  12. regression: muse + mimo + space-bunny still complete unchanged

import * as http from "node:http"
import { handleChatRequest } from "../api/chat"
import { handleResponsesRequest } from "../api/responses"
import { handleMessagesRequest } from "../api/messages"
import { modelsList } from "../api/models"

const PORT = 8915
const KEY = process.env.PROXY_API_KEY ?? "smoke-key"
const BASE = `http://127.0.0.1:${PORT}`
const MODEL = "step-5-preview-free"

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
      if (req.url === "/v1/models") {
        const body = modelsList(Math.floor(Date.now() / 1000))
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
        return
      }
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

// The free tier is IP-rate-limited; 429 is a transient backpressure signal,
// not a proxy failure (the repo's probe scripts retry the same way).
async function postRetrying(path: string, body: unknown, auth?: Record<string, string>, attempts = 4): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    const res = await post(path, body, auth)
    if (res.status !== 429 || i === attempts - 1) return res
    console.log(`      upstream 429 (rate limited), retrying in ${5 * (i + 1)}s…`)
    await new Promise((r) => setTimeout(r, 5000 * (i + 1)))
  }
  return post(path, body, auth)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
// 1) catalog entry
// ---------------------------------------------------------------------------

async function catalogEntry(): Promise<void> {
  const res = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } })
  expect(res.status === 200, "[catalog] HTTP 200", `status=${res.status}`)
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
  const entry = (body.data ?? []).find((m) => m.id === MODEL)
  expect(entry !== undefined, "[catalog] step-5-preview-free present")
  if (!entry) return
  expect(entry.reasoning === true, "[catalog] reasoning=true")
  expect(
    (entry.reasoning_levels as string[] | undefined)?.join(",") === "minimal,low,medium,high,xhigh,max",
    "[catalog] levels minimal..max (none clamped)",
    JSON.stringify(entry.reasoning_levels),
  )
  expect(entry.context_window === 1_000_000, "[catalog] context_window 1,000,000", String(entry.context_window))
  expect(entry.max_output_tokens === 32_000, "[catalog] max_output_tokens 32,000", String(entry.max_output_tokens))
  expect(entry.owned_by === "opencode-zen", "[catalog] owned_by opencode-zen", String(entry.owned_by))
  const ids = (body.data ?? []).map((m) => m.id as string)
  expect(ids.length === 4, "[catalog] exactly four models listed", ids.join(","))
}

// ---------------------------------------------------------------------------
// 2) alias routing (canonical id echoed back)
// ---------------------------------------------------------------------------

async function aliasRouting(): Promise<void> {
  for (const alias of ["step5", "Step-5-Preview-Free", "step-5-preview"]) {
    const res = await post("/v1/chat/completions", {
      model: alias,
      stream: false,
      messages: [{ role: "user", content: "Reply with exactly: ALIAS-OK" }],
    })
    const body = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> }
    expect(res.status === 200 && body.model === MODEL, `[alias] "${alias}" routes to step-5 (HTTP 200, canonical echo)`, `status=${res.status} model=${body.model}`)
    expect((body.choices?.[0]?.message?.content ?? "").includes("ALIAS-OK"), `[alias] "${alias}" answers`, (body.choices?.[0]?.message?.content ?? "").slice(0, 60))
  }
}

// ---------------------------------------------------------------------------
// 3) chat facade
// ---------------------------------------------------------------------------

async function chatNonStreaming(): Promise<void> {
  const res = await post("/v1/chat/completions", {
    model: MODEL,
    stream: false,
    messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
  })
  expect(res.status === 200, "[chat] non-stream HTTP 200", `status=${res.status}`)
  const body = (await res.json()) as {
    model?: string
    choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>
    usage?: { total_tokens?: number }
  }
  expect(body.model === MODEL, "[chat] non-stream echoes model id", String(body.model))
  const content = body.choices?.[0]?.message?.content ?? ""
  expect(content.includes("4"), "[chat] non-stream answers 4", content.slice(0, 60))
  expect(body.choices?.[0]?.finish_reason === "stop", "[chat] non-stream finish stop")
  expect((body.usage?.total_tokens ?? 0) > 0, "[chat] non-stream usage", JSON.stringify(body.usage))
}

async function chatStreaming(): Promise<void> {
  const res = await post("/v1/chat/completions", {
    model: MODEL,
    stream: true,
    reasoning_effort: "high",
    messages: [{ role: "user", content: "What is 7*8? Think briefly, then reply with just the number." }],
  })
  expect(res.status === 200, "[chat] stream HTTP 200", `status=${res.status}`)
  const text = await res.text()
  const chunks = sseDataLines(text)
  expect(text.trimEnd().endsWith("data: [DONE]"), "[chat] stream ends with [DONE]")
  let content = ""
  for (const chunk of chunks) {
    const c = chunk as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }> }
    content += c.choices?.[0]?.delta?.content ?? ""
  }
  expect(content.includes("56"), "[chat] stream answers 56", content.slice(0, 60))
  const finish = chunks
    .map((c) => (c as { choices?: Array<{ finish_reason?: string | null }> }).choices?.[0]?.finish_reason)
    .filter((f): f is string => typeof f === "string")
  expect(finish.at(-1) === "stop", "[chat] stream finish stop", finish.join(","))
}

// ---------------------------------------------------------------------------
// 4) responses facade
// ---------------------------------------------------------------------------

async function responsesNonStreaming(): Promise<void> {
  const res = await post("/v1/responses", { model: MODEL, input: "What is 3+3? Reply with just the number.", stream: false })
  expect(res.status === 200, "[responses] non-stream HTTP 200", `status=${res.status}`)
  const body = (await res.json()) as { object?: string; status?: string; model?: string; output_text?: string; usage?: { total_tokens?: number } }
  expect(body.object === "response", "[responses] non-stream object", String(body.object))
  expect(body.status === "completed", "[responses] non-stream completed", String(body.status))
  expect(body.model === MODEL, "[responses] non-stream echoes model id", String(body.model))
  expect((body.output_text ?? "").includes("6"), "[responses] non-stream output_text", (body.output_text ?? "").slice(0, 60))
  expect((body.usage?.total_tokens ?? 0) > 0, "[responses] non-stream usage", JSON.stringify(body.usage))
}

async function responsesStreaming(): Promise<void> {
  const res = await post("/v1/responses", { model: MODEL, input: "What is 9*7? Think briefly, then reply with just the number.", stream: true, reasoning: { effort: "high" } })
  expect(res.status === 200, "[responses] stream HTTP 200", `status=${res.status}`)
  const text = await res.text()
  const frames = sseFrames(text)
  const types = frames.map((f) => f.type)
  expect(types[0] === "response.created", "[responses] stream starts with response.created", types[0])
  expect(types.at(-1) === "response.completed", "[responses] stream ends with response.completed", String(types.at(-1)))
  expect(types.includes("response.output_item.added"), "[responses] stream has output_item.added")
  expect(types.includes("response.output_text.done"), "[responses] stream has output_text.done")
  expect(!types.includes("ping"), "[responses] stream filters ping")
  const deltas = frames
    .filter((f) => f.type === "response.output_text.delta")
    .map((f) => (f.data as { delta?: string }).delta ?? "")
    .join("")
  expect(deltas.includes("63"), "[responses] stream answers 63", deltas.slice(0, 60))
  const completed = frames.find((f) => f.type === "response.completed")
  expect(((completed?.data as { response?: { model?: string } } | undefined)?.response?.model) === MODEL, "[responses] completed model echo")
  const usage = (completed?.data as { response?: { usage?: { total_tokens?: number } } } | undefined)?.response?.usage
  expect((usage?.total_tokens ?? 0) > 0, "[responses] completed usage", JSON.stringify(usage))
}

// ---------------------------------------------------------------------------
// 5) messages facade
// ---------------------------------------------------------------------------

async function messagesNonStreaming(): Promise<void> {
  const res = await post(
    "/v1/messages",
    {
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: "What is 5+5? Think briefly, then reply with just the number." }],
    },
    { "x-api-key": KEY },
  )
  expect(res.status === 200, "[messages] non-stream HTTP 200", `status=${res.status}`)
  const body = (await res.json()) as {
    type?: string
    model?: string
    stop_reason?: string
    content?: Array<{ type: string; text?: string; thinking?: string }>
    usage?: { output_tokens?: number }
  }
  expect(body.type === "message", "[messages] non-stream type", String(body.type))
  expect(body.model === MODEL, "[messages] non-stream echoes model id", String(body.model))
  const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
  expect(text.includes("10"), "[messages] non-stream answers 10", text.slice(0, 60))
  expect(body.stop_reason === "end_turn", "[messages] non-stream stop_reason", String(body.stop_reason))
  expect((body.usage?.output_tokens ?? 0) > 0, "[messages] non-stream usage", JSON.stringify(body.usage))
}

async function messagesStreaming(): Promise<void> {
  const res = await post(
    "/v1/messages",
    {
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: "What is 6*6? Think briefly, then reply with just the number." }],
      stream: true,
    },
    { "x-api-key": KEY },
  )
  expect(res.status === 200, "[messages] stream HTTP 200", `status=${res.status}`)
  const text = await res.text()
  const frames = sseFrames(text)
  const types = frames.map((f) => f.type)
  expect(types[0] === "message_start", "[messages] stream starts with message_start", types[0])
  expect(types.at(-1) === "message_stop", "[messages] stream ends with message_stop", String(types.at(-1)))
  expect(types.includes("message_delta"), "[messages] stream has message_delta")
  expect(!types.includes("ping"), "[messages] stream filters ping")
  const textOut = frames
    .filter((f) => f.type === "content_block_delta" && (f.data as { delta?: { type?: string } }).delta?.type === "text_delta")
    .map((f) => (f.data as { delta: { text: string } }).delta.text)
    .join("")
  expect(textOut.includes("36"), "[messages] stream answers 36", textOut.slice(0, 60))
  const messageDelta = frames.find((f) => f.type === "message_delta")
  const stopReason = (messageDelta?.data as { delta?: { stop_reason?: string } } | undefined)?.delta?.stop_reason
  expect(stopReason === "end_turn", "[messages] stream stop_reason", String(stopReason))
}

// ---------------------------------------------------------------------------
// 6) reasoning streams on all three facades
// ---------------------------------------------------------------------------

const REASONING_PROMPTS = [
  "Think step by step: a train travels 60 km in 45 minutes. What is its speed in km/h? Reply with just the number.",
  "Think briefly, then name the third planet from the sun. Reply with just the name.",
  "Carefully think it through: what is the square root of 169? Reply with just the number.",
]

async function reasoningCharsChat(prompt: string): Promise<number> {
  const res = await post("/v1/chat/completions", {
    model: MODEL,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  })
  if (res.status !== 200) return -1
  let reasoning = 0
  for (const chunk of sseDataLines(await res.text())) {
    reasoning += ((chunk as { choices?: Array<{ delta?: { reasoning_content?: string } }> }).choices?.[0]?.delta?.reasoning_content ?? "").length
  }
  return reasoning
}

async function reasoningCharsResponses(prompt: string): Promise<number> {
  const res = await post("/v1/responses", { model: MODEL, input: prompt, stream: true })
  if (res.status !== 200) return -1
  let reasoning = 0
  for (const frame of sseFrames(await res.text())) {
    if (frame.type === "response.reasoning_text.delta") reasoning += ((frame.data as { delta?: string }).delta ?? "").length
  }
  return reasoning
}

async function reasoningCharsMessages(prompt: string): Promise<number> {
  const res = await post("/v1/messages", { model: MODEL, max_tokens: 2048, messages: [{ role: "user", content: prompt }], stream: true }, { "x-api-key": KEY })
  if (res.status !== 200) return -1
  let reasoning = 0
  for (const frame of sseFrames(await res.text())) {
    if (frame.type === "content_block_delta" && (frame.data as { delta?: { type?: string } }).delta?.type === "thinking_delta") {
      reasoning += ((frame.data as { delta: { thinking: string } }).delta.thinking ?? "").length
    }
  }
  return reasoning
}

async function reasoningStreams(): Promise<void> {
  const probes: Array<[string, (p: string) => Promise<number>]> = [
    ["chat (reasoning_content)", reasoningCharsChat],
    ["responses (reasoning_text.delta)", reasoningCharsResponses],
    ["messages (thinking_delta)", reasoningCharsMessages],
  ]
  for (const [label, probe] of probes) {
    // A reasoning model MAY stay silent on a trivial prompt (observed on the
    // real edge), so retry with progressively harder prompts before failing.
    let best = 0
    const seen: number[] = []
    for (const prompt of REASONING_PROMPTS) {
      const chars = await probe(prompt)
      seen.push(chars)
      if (chars > best) best = chars
      if (chars > 0) break
      await sleep(1000)
    }
    expect(best > 0, `[reasoning] ${label} stream present`, `attempts=${seen.join(",")}`)
  }
}

// ---------------------------------------------------------------------------
// 7) chat tool loop with grounding
// ---------------------------------------------------------------------------

async function chatToolLoop(): Promise<void> {
  const ask = "What is the city report for Tokyo? Use the get_city_report tool, then tell me the temperature and the report id."
  const res1 = await post("/v1/chat/completions", {
    model: MODEL,
    stream: true,
    messages: [{ role: "user", content: ask }],
    tools: [CITY_TOOL_CHAT],
    tool_choice: "auto",
  })
  expect(res1.status === 200, "[tools/chat] turn1 HTTP 200", `status=${res1.status}`)
  if (res1.status !== 200) {
    console.log(`      body: ${(await res1.text()).slice(0, 200)}`)
    return
  }
  const chunks1 = sseDataLines(await res1.text())
  const calls: Array<{ id: string; name: string; arguments: string }> = []
  let finish1 = ""
  for (const chunk of chunks1) {
    const c = chunk as { choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }> }
    for (const call of c.choices?.[0]?.delta?.tool_calls ?? []) {
      if (call.id && call.function?.name) {
        calls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments ?? "" })
      } else if (call.function?.arguments && calls.length > 0) {
        calls[calls.length - 1]!.arguments += call.function.arguments
      }
    }
    if (typeof c.choices?.[0]?.finish_reason === "string") finish1 = c.choices[0].finish_reason
  }
  const cityCall = calls.find((c) => c.name === "get_city_report")
  expect(cityCall !== undefined, "[tools/chat] turn1 calls the CLIENT tool get_city_report", calls.map((c) => c.name).join(","))
  expect(finish1 === "tool_calls", "[tools/chat] turn1 finish tool_calls", finish1)
  if (!cityCall) return
  let parsedArgs = ""
  try {
    const parsed = JSON.parse(cityCall.arguments || "{}") as { city?: string }
    parsedArgs = typeof parsed.city === "string" ? parsed.city : ""
    expect(true, "[tools/chat] turn1 streamed arguments are valid JSON", cityCall.arguments.slice(0, 80))
  } catch (error) {
    expect(false, "[tools/chat] turn1 streamed arguments are valid JSON", String(error))
  }
  expect(parsedArgs.length > 0, "[tools/chat] turn1 extracted city argument", parsedArgs)

  const res2 = await post("/v1/chat/completions", {
    model: MODEL,
    stream: true,
    messages: [
      { role: "user", content: ask },
      { role: "assistant", content: null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) },
      { role: "tool", tool_call_id: cityCall.id, content: executeCityTool(cityCall.arguments) },
    ],
    tools: [CITY_TOOL_CHAT],
  })
  expect(res2.status === 200, "[tools/chat] turn2 HTTP 200", `status=${res2.status}`)
  if (res2.status !== 200) {
    console.log(`      body: ${(await res2.text()).slice(0, 200)}`)
    return
  }
  const chunks2 = sseDataLines(await res2.text())
  let content2 = ""
  let finish2 = ""
  for (const chunk of chunks2) {
    const c = chunk as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> }
    content2 += c.choices?.[0]?.delta?.content ?? ""
    if (typeof c.choices?.[0]?.finish_reason === "string") finish2 = c.choices[0].finish_reason
  }
  expect(finish2 === "stop", "[tools/chat] turn2 finish stop", finish2)
  expect(content2.includes("17"), "[tools/chat] turn2 uses the tool result (temperature 17)", content2.slice(0, 90).replace(/\n/g, " "))
  expect(content2.includes(SENTINEL), `[tools/chat] turn2 grounded on sentinel ${SENTINEL}`, content2.slice(0, 90).replace(/\n/g, " "))
}

// ---------------------------------------------------------------------------
// 8) parallel tool calls replayed merged in ONE assistant message
// ---------------------------------------------------------------------------

async function parallelToolReplay(): Promise<void> {
  const ask = "Get the city report for Tokyo AND the city report for Berlin in parallel (two get_city_report calls in one round). Then list both report ids."
  const res1 = await post("/v1/chat/completions", {
    model: MODEL,
    stream: true,
    messages: [{ role: "user", content: ask }],
    tools: [CITY_TOOL_CHAT],
    tool_choice: "auto",
  })
  expect(res1.status === 200, "[parallel] turn1 HTTP 200", `status=${res1.status}`)
  if (res1.status !== 200) return
  const chunks1 = sseDataLines(await res1.text())
  const calls: Array<{ id: string; name: string; arguments: string }> = []
  for (const chunk of chunks1) {
    const c = chunk as { choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }> }
    for (const call of c.choices?.[0]?.delta?.tool_calls ?? []) {
      if (call.id && call.function?.name) {
        calls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments ?? "" })
      } else if (call.function?.arguments && calls.length > 0) {
        calls[calls.length - 1]!.arguments += call.function.arguments
      }
    }
  }
  const clientCalls = calls.filter((c) => c.name === "get_city_report")
  expect(clientCalls.length >= 2, "[parallel] turn1 issued two parallel calls", clientCalls.map((c) => c.arguments).join(" | ").slice(0, 120))
  if (clientCalls.length < 2) return

  // Replay BOTH calls inside ONE assistant message (the merged shape the
  // proxy's lower layer produces; splitting them 400s on space-bunny).
  const res2 = await post("/v1/chat/completions", {
    model: MODEL,
    stream: true,
    messages: [
      { role: "user", content: ask },
      {
        role: "assistant",
        content: null,
        tool_calls: clientCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      },
      ...clientCalls.map((c) => ({ role: "tool", tool_call_id: c.id, content: executeCityTool(c.arguments) })),
    ],
    tools: [CITY_TOOL_CHAT],
  })
  expect(res2.status === 200, "[parallel] merged replay HTTP 200 (no 400)", `status=${res2.status}`)
  if (res2.status !== 200) {
    console.log(`      body: ${(await res2.text()).slice(0, 200)}`)
    return
  }
  const chunks2 = sseDataLines(await res2.text())
  let content2 = ""
  for (const chunk of chunks2) {
    content2 += (chunk as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? ""
  }
  expect(content2.includes(SENTINEL), `[parallel] turn2 grounded on sentinel ${SENTINEL}`, content2.slice(0, 120).replace(/\n/g, " "))
}

// ---------------------------------------------------------------------------
// 9) reasoning efforts end-to-end (none is clamped — upstream 400s on it)
// ---------------------------------------------------------------------------

async function efforts(): Promise<void> {
  for (const effort of ["none", "minimal", "high", "max"]) {
    let res = await postRetrying("/v1/chat/completions", {
      model: MODEL,
      stream: true,
      reasoning_effort: effort,
      messages: [{ role: "user", content: "What is 12 * 12? Reply with just the number." }],
    })
    let content = ""
    if (res.status === 200) {
      for (const chunk of sseDataLines(await res.text())) {
        content += (chunk as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? ""
      }
    } else {
      console.log(`      body: ${(await res.text()).slice(0, 160)}`)
    }
    expect(res.status === 200 && content.includes("144"), `[effort] ${effort} completes with 144`, `status=${res.status} ${content.slice(0, 40)}`)
    await sleep(1200)
  }
}

// ---------------------------------------------------------------------------
// 10) multi-turn memory
// ---------------------------------------------------------------------------

async function multiTurnMemory(): Promise<void> {
  const magic = `MAGIC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  const turn1 = await post("/v1/chat/completions", {
    model: MODEL,
    stream: false,
    messages: [{ role: "user", content: `Remember this code: ${magic}. Just reply OK.` }],
  })
  expect(turn1.status === 200, "[memory] turn1 HTTP 200", `status=${turn1.status}`)
  const turn2 = await post("/v1/chat/completions", {
    model: MODEL,
    stream: false,
    messages: [
      { role: "user", content: `Remember this code: ${magic}. Just reply OK.` },
      { role: "assistant", content: "OK" },
      { role: "user", content: "What was the code I asked you to remember? Reply with just the code." },
    ],
  })
  expect(turn2.status === 200, "[memory] turn2 HTTP 200", `status=${turn2.status}`)
  const body = (await turn2.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = body.choices?.[0]?.message?.content ?? ""
  expect(content.includes(magic), "[memory] recalls the code", content.slice(0, 80))
}

// ---------------------------------------------------------------------------
// 11) large streaming generation
// ---------------------------------------------------------------------------

async function largeStreaming(): Promise<void> {
  const res = await post("/v1/chat/completions", {
    model: MODEL,
    stream: true,
    messages: [{ role: "user", content: SNAKE_PROMPT }],
  })
  expect(res.status === 200, "[large] stream HTTP 200", `status=${res.status}`)
  const chunks = sseDataLines(await res.text())
  const full = chunks
    .map((c) => (c as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content)
    .filter((v): v is string => typeof v === "string")
    .join("")
  const deltaCount = chunks.filter((c) => {
    const d = (c as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content
    return typeof d === "string" && d.length > 0
  }).length
  expect(deltaCount > 20, "[large] many deltas", `deltas=${deltaCount}`)
  expect(full.length > 2000, "[large] long output", `chars=${full.length}`)
  expect(full.includes("<canvas"), "[large] contains canvas")
  expect(full.includes("</html>"), "[large] reaches the end of the document")
  const usageChunk = chunks.find((c) => (c as { usage?: { total_tokens?: number } }).usage !== undefined) as { usage?: { total_tokens?: number } } | undefined
  expect((usageChunk?.usage?.total_tokens ?? 0) > 0, "[large] usage chunk", JSON.stringify(usageChunk?.usage))
}

// ---------------------------------------------------------------------------
// 12) regression: the other three models are untouched
// ---------------------------------------------------------------------------

async function regression(): Promise<void> {
  const cases: Array<[string, string]> = [
    ["muse-spark-1.3-contributor-free", "MUSE-OK"],
    ["mimo-v2.6-flash-free", "MIMO-OK"],
    ["space-bunny-free", "BUNNY-OK"],
  ]
  for (const [model, token] of cases) {
    const res = await post("/v1/chat/completions", {
      model,
      stream: false,
      messages: [{ role: "user", content: `Reply with exactly: ${token}` }],
    })
    let content = ""
    let echoed = ""
    if (res.status === 200) {
      const body = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> }
      echoed = body.model ?? ""
      content = body.choices?.[0]?.message?.content ?? ""
    } else {
      console.log(`      body: ${(await res.text()).slice(0, 160)}`)
    }
    expect(res.status === 200 && content.includes(token) && echoed === model, `[regression] ${model} unchanged`, `status=${res.status} model=${echoed} ${content.slice(0, 40)}`)
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await startServer()
  console.log(`\n=== STEP-5-PREVIEW-FREE full-link smoke on real opencode zen (proxy at ${BASE}, sentinel ${SENTINEL}) ===`)
  const steps: Array<[string, () => Promise<void>]> = [
    ["1/12 catalog entry", catalogEntry],
    ["2/12 alias routing", aliasRouting],
    ["3/12 chat non-streaming", chatNonStreaming],
    ["4/12 chat streaming", chatStreaming],
    ["5/12 responses non-streaming", responsesNonStreaming],
    ["6/12 responses streaming", responsesStreaming],
    ["7/12 messages non-streaming", messagesNonStreaming],
    ["8/12 messages streaming", messagesStreaming],
    ["9/12 reasoning streams on all facades", reasoningStreams],
    ["10/12 chat tool loop (grounded)", chatToolLoop],
    ["11/12 parallel tool replay (merged)", parallelToolReplay],
    ["12/12 efforts none/minimal/high/max", efforts],
    ["13/12 multi-turn memory", multiTurnMemory],
    ["14/12 large streaming", largeStreaming],
    ["15/12 regression (muse/mimo/space-bunny)", regression],
  ]
  for (const [name, fn] of steps) {
    console.log(`\n--- ${name} ---`)
    try {
      await fn()
    } catch (error) {
      bad(`${name} crashed`, String(error))
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
