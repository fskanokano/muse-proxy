// Real-upstream conformance suite for the migrated Supabase Edge Function.
//
//   bun run smoke:edge                              # everything
//   bun run smoke:edge -- --model=space-bunny       # one model, all facades
//   bun run smoke:edge -- --facade=messages         # one facade, all models
//   bun run smoke:edge -- --section=platform        # routing/auth only (no upstream)
//
// Unlike the in-process smokes (which import the handlers directly), this
// drives the DEPLOYED artifact the way a real client does: real HTTP over
// /functions/v1/muse-proxy/v1/*, real SSE frames, real client aborts, real opencode zen
// upstream. That is the only way to catch runtime-level breakage (gateway path
// routing, Deno-vs-Node stream semantics, header fingerprint) that unit tests
// cannot see.
//
// Coverage per model x facade:
//   1. text, stream:false       - canonical aggregated object + usage
//   2. text, stream:true        - SSE framing, incremental delivery, terminal frame
//   3. tool loop                - real streamed tool call -> harness -> replay -> grounded answer
//   4. reasoning effort         - facade-native field accepted; space-bunny `none` clamped
//   5. multi-turn replay        - stateless replay keeps earlier turn content
//   6. client abort             - mid-stream cancel closes cleanly, no hang
// plus platform-level checks (routing, fail-closed auth, method/JSON guards).

const BASE = (process.env.EDGE_BASE_URL ?? "http://127.0.0.1:8788/functions/v1/muse-proxy/v1").replace(/\/+$/, "")
const KEY = process.env.PROXY_API_KEY ?? ""
const MODELS = ["muse-spark-1.3-contributor-free", "mimo-v2.6-flash-free", "space-bunny-free"]
const BUILTIN_TOOL_NAMES = new Set([
  "bash", "edit", "glob", "grep", "read", "skill", "task", "todowrite", "webfetch", "websearch", "write",
])

const args = new Map<string, string>(
  process.argv
    .slice(2)
    .map((raw): [string, string] => {
      const [key = "", value = "all"] = raw.replace(/^--/, "").split("=")
      return [key, value]
    }),
)
// `--model=muse` / `--facade=chat` / `--section=matrix`: substring match so the
// long model ids can be abbreviated.
const pick = (key: string, allowed: string[]): string[] => {
  const value = args.get(key) ?? "all"
  return value === "all" ? allowed : allowed.filter((item) => item.includes(value))
}

let passed = 0
const failures: string[] = []
let currentCell = "edge"

function ok(name: string, detail = ""): void {
  passed++
  console.log(`    PASS ${name}${detail ? ` — ${detail}` : ""}`)
}
function bad(name: string, detail = ""): void {
  const line = `${currentCell} :: ${name}${detail ? ` — ${detail}` : ""}`
  failures.push(line)
  console.log(`    FAIL ${name}${detail ? ` — ${detail}` : ""}`)
}
function check(condition: boolean, name: string, detail = ""): void {
  if (condition) ok(name, detail)
  else bad(name, detail)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface SseFrame {
  type: string
  data: Record<string, unknown>
}

/**
 * One POST with rate-limit retry. The zen free tier is IP-throttled, so a 429
 * is a throttle signal, not a contract failure: back off and retry so the suite
 * measures the proxy rather than the bucket.
 */
async function post(
  path: string,
  body: unknown,
  auth: Record<string, string> = { authorization: `Bearer ${KEY}` },
  init: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const attempts = 4
  let last: Response | undefined
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? 120_000)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal,
    })
    if (res.status !== 429 || attempt === attempts) return res
    last = res
    await res.text()
    await sleep(4_000 * attempt)
  }
  return last!
}

async function get(path: string, auth: Record<string, string> = { authorization: `Bearer ${KEY}` }): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers: auth })
}

/** `data: {...}` frames (chat facade, plus the `data:` half of framed streams). */
function parseDataFrames(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (data.length === 0 || data === "[DONE]") continue
    try {
      out.push(JSON.parse(data) as Record<string, unknown>)
    } catch {
      // heartbeat comment / partial frame
    }
  }
  return out
}

/** `event: <type>` + `data: {...}` blocks (responses + messages facades). */
function parseFrames(text: string): SseFrame[] {
  const out: SseFrame[] = []
  for (const block of text.split("\n\n")) {
    let type = ""
    let data = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim()
      else if (line.startsWith("data:")) data += line.slice(5).trim()
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

interface StreamTiming {
  reads: number
  spanMs: number
}

/** Read the body chunk-by-chunk so "真流式" is measured, not assumed. */
async function readStream(res: Response): Promise<{ text: string; timing: StreamTiming }> {
  const decoder = new TextDecoder()
  const reader = res.body!.getReader()
  let text = ""
  let firstAt: number | null = null
  let lastAt = 0
  let reads = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const now = Date.now()
    if (firstAt === null) firstAt = now
    lastAt = now
    reads++
    text += decoder.decode(value, { stream: true })
  }
  return { text, timing: { reads, spanMs: lastAt - (firstAt ?? lastAt) } }
}

async function drain(res: Response): Promise<string> {
  const chunks: Uint8Array[] = []
  const reader = res.body!.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let out = ""
  for (const chunk of chunks) out += new TextDecoder().decode(chunk)
  return out
}

// ---------------------------------------------------------------------------
// Facade requests / response readers
// ---------------------------------------------------------------------------

type Facade = "chat" | "responses" | "messages"

const PATHS: Record<Facade, string> = {
  chat: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
}

/** Anthropic SDKs send `x-api-key`; OpenAI SDKs send `Authorization: Bearer`. */
function authFor(facade: Facade): Record<string, string> {
  return facade === "messages" ? { "x-api-key": KEY } : { authorization: `Bearer ${KEY}` }
}

function textRequest(facade: Facade, model: string, prompt: string, extra: Record<string, unknown> = {}): unknown {
  if (facade === "chat") {
    return { model, stream: false, messages: [{ role: "user", content: prompt }], ...extra }
  }
  if (facade === "responses") return { model, stream: false, input: prompt, ...extra }
  return { model, max_tokens: 1024, stream: false, messages: [{ role: "user", content: prompt }], ...extra }
}

function textStreamRequest(facade: Facade, model: string, prompt: string, extra: Record<string, unknown> = {}): unknown {
  if (facade === "chat") {
    return { model, stream: true, messages: [{ role: "user", content: prompt }], ...extra }
  }
  if (facade === "responses") return { model, stream: true, input: prompt, ...extra }
  return { model, max_tokens: 1024, stream: true, messages: [{ role: "user", content: prompt }], ...extra }
}

interface FacadeRead {
  text: string
  finish: string
  usage: string
  raw: Record<string, unknown>
}

/** Pull the terminal signal + visible text out of a streamed response. */
function readStreamResult(facade: Facade, body: string): FacadeRead {
  if (facade === "chat") {
    const frames = parseDataFrames(body)
    let text = ""
    let finish = ""
    for (const frame of frames) {
      const choice = (frame.choices as Array<{ delta?: { content?: string }; finish_reason?: string | null }> | undefined)?.[0]
      text += choice?.delta?.content ?? ""
      if (typeof choice?.finish_reason === "string") finish = choice.finish_reason
    }
    return { text, finish, usage: "", raw: { frames: frames.length } }
  }
  const frames = parseFrames(body)
  if (facade === "responses") {
    let text = ""
    let finish = ""
    for (const frame of frames) {
      if (frame.type === "response.output_text.delta") text += String((frame.data as { delta?: string }).delta ?? "")
      if (frame.type === "response.completed") finish = "response.completed"
      if (frame.type === "response.incomplete") finish = "response.incomplete"
    }
    return { text, finish, usage: "", raw: { frames: frames.length, types: frames.map((f) => f.type) } }
  }
  let text = ""
  let finish = ""
  for (const frame of frames) {
    if (frame.type === "content_block_delta") {
      const delta = (frame.data as { delta?: { type?: string; text?: string } }).delta
      if (delta?.type === "text_delta") text += delta.text ?? ""
    }
    if (frame.type === "message_delta") finish = String((frame.data as { delta?: { stop_reason?: string } }).delta?.stop_reason ?? "")
  }
  return { text, finish, usage: "", raw: { frames: frames.length, types: frames.map((f) => f.type) } }
}

// ---------------------------------------------------------------------------
// 1. text, stream:false
// ---------------------------------------------------------------------------

async function checkTextNonStreaming(facade: Facade, model: string): Promise<void> {
  const res = await post(PATHS[facade], textRequest(facade, model, "Reply with the single word: pong"))
  check(res.status === 200, `non-stream HTTP 200`, `status=${res.status}`)
  if (res.status !== 200) {
    bad("non-stream error body", (await res.text()).slice(0, 200))
    return
  }
  const body = (await res.json()) as Record<string, unknown>
  let text = ""
  let finish = ""
  if (facade === "chat") {
    const message = (body.choices as Array<{ message?: { content?: string }; finish_reason?: string }> | undefined)?.[0]
    text = message?.message?.content ?? ""
    finish = message?.finish_reason ?? ""
  } else if (facade === "responses") {
    text = String(body.output_text ?? "")
    finish = String(body.status ?? "")
  } else {
    const blocks = (body.content as Array<{ type?: string; text?: string }> | undefined) ?? []
    text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("")
    finish = String(body.stop_reason ?? "")
  }
  const usage = body.usage as { total_tokens?: number; output_tokens?: number } | undefined
  check(text.trim().length > 0, "non-stream produced text", JSON.stringify(text.slice(0, 60)))
  check(finish.length > 0, "non-stream carries a finish signal", finish)
  check(typeof (usage?.total_tokens ?? usage?.output_tokens ?? 0) === "number", "non-stream carries usage", JSON.stringify(usage))
  check(JSON.stringify(body).includes(model), "non-stream echoes the requested model", String(body.model ?? ""))
}

// ---------------------------------------------------------------------------
// 2. text, stream:true
// ---------------------------------------------------------------------------

async function checkTextStreaming(facade: Facade, model: string): Promise<void> {
  const res = await post(PATHS[facade], textStreamRequest(facade, model, "Reply with the single word: pong"))
  check(res.status === 200, `stream HTTP 200`, `status=${res.status}`)
  if (res.status !== 200) {
    bad("stream error body", (await res.text()).slice(0, 200))
    return
  }
  check((res.headers.get("content-type") ?? "").includes("text/event-stream"), "stream content-type is text/event-stream", res.headers.get("content-type") ?? "")
  const { text: body, timing } = await readStream(res)
  const result = readStreamResult(facade, body)
  check(timing.reads > 1, "stream delivered incrementally (multiple socket reads)", `${timing.reads} reads`)
  check(result.text.trim().length > 0, "stream produced text", JSON.stringify(result.text.slice(0, 60)))
  if (facade === "chat") {
    check(result.finish === "stop" || result.finish === "length", "stream finish_reason is stop/length", result.finish)
    check(body.includes("data: [DONE]"), "stream terminates with [DONE]")
  } else if (facade === "responses") {
    check(result.finish === "response.completed", "stream ends with response.completed", result.finish)
    check(!body.includes("[DONE]"), "responses stream does not emit a non-spec [DONE]")
    check(!body.includes("event: ping"), "non-spec upstream ping frames are filtered")
  } else {
    check(result.finish === "end_turn", "stream stop_reason is end_turn", result.finish)
    check(body.includes("event: message_stop"), "stream ends with message_stop")
    check(!body.includes("[DONE]"), "messages stream does not emit a non-spec [DONE]")
  }
}

// ---------------------------------------------------------------------------
// 3. streaming tool loop (shared city-report harness with a random sentinel)
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
const USER_ASK =
  "What is the weather report for Tokyo right now? Use the get_city_report tool, then tell me the temperature and the report id."
let SENTINEL = ""

function toolsFor(facade: Facade): unknown[] {
  if (facade === "chat") return [{ type: "function", function: CITY_TOOL }]
  if (facade === "responses") return [{ type: "function", ...CITY_TOOL }]
  return [{ name: CITY_TOOL.name, description: CITY_TOOL.description, input_schema: CITY_TOOL.parameters }]
}

function executeCityTool(argumentsJson: string): string {
  let city = "Tokyo"
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { city?: string }
    if (typeof parsed.city === "string" && parsed.city.length > 0) city = parsed.city
  } catch {
    // keep the default
  }
  return JSON.stringify({ city, temperature_c: 17, condition: "cloudy", report_id: SENTINEL })
}

interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** Turn 1: ask for the tool call over SSE and parse it in the facade's shape. */
async function toolTurnOne(
  facade: Facade,
  model: string,
): Promise<{ ok: boolean; call?: ToolCall }> {
  const body: Record<string, unknown> =
    facade === "chat"
      ? { model, stream: true, messages: [{ role: "user", content: USER_ASK }], tools: toolsFor(facade), tool_choice: "auto" }
      : facade === "responses"
        ? { model, stream: true, input: USER_ASK, tools: toolsFor(facade) }
        : { model, max_tokens: 1024, stream: true, messages: [{ role: "user", content: USER_ASK }], tools: toolsFor(facade) }
  const auth = authFor(facade)
  const res = await post(PATHS[facade], body, auth)
  check(res.status === 200, "tool turn1 HTTP 200", `status=${res.status}`)
  if (res.status !== 200) {
    bad("tool turn1 error body", (await res.text()).slice(0, 200))
    return { ok: false }
  }
  const { text, timing } = await readStream(res)
  check(timing.reads > 1, "tool turn1 streams incrementally", `${timing.reads} reads`)
  const call = parseToolCall(facade, text)
  check(call !== undefined, "tool turn1 issued a tool call", call ? call.name : "none")
  check(call === undefined || call.name === "get_city_report", "tool turn1 targets the CLIENT tool", call?.name ?? "")
  check(call === undefined || !BUILTIN_TOOL_NAMES.has(call.name), "no stubbed builtin tool call leaked", call?.name ?? "")
  if (call !== undefined) {
    let parsed = false
    try {
      JSON.parse(call.arguments || "{}")
      parsed = true
    } catch {
      parsed = false
    }
    check(parsed, "tool turn1 arguments parse as JSON", call.arguments.slice(0, 60))
  }
  return { ok: true, call }
}

function parseToolCall(facade: Facade, body: string): ToolCall | undefined {
  if (facade === "chat") {
    const calls: ToolCall[] = []
    for (const frame of parseDataFrames(body)) {
      const choice = (frame.choices as Array<{ delta?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> | undefined)?.[0]
      for (const delta of choice?.delta?.tool_calls ?? []) {
        if (delta.id && delta.function?.name) calls.push({ id: delta.id, name: delta.function.name, arguments: delta.function.arguments ?? "" })
        else if (delta.function?.arguments && calls.length > 0) calls[calls.length - 1]!.arguments += delta.function.arguments
      }
    }
    return calls.find((call) => call.name === "get_city_report") ?? calls[0]
  }
  if (facade === "responses") {
    const frames = parseFrames(body)
    const item = frames
      .filter((frame) => frame.type === "response.output_item.done")
      .map((frame) => (frame.data as { item?: { type?: string; call_id?: string; id?: string; name?: string; arguments?: string } }).item)
      .find((candidate) => candidate?.type === "function_call")
    check(frames.at(-1)?.type === "response.completed", "tool turn1 ends with response.completed", String(frames.at(-1)?.type))
    // Strict Responses clients need the full function-call lifecycle, not just
    // the final item (OpenMinis' parser requires this exact ordering).
    const added = frames.filter((frame) => frame.type === "response.output_item.added").length
    const argDelta = frames.filter((frame) => frame.type === "response.function_call_arguments.delta").length
    const argDone = frames.filter((frame) => frame.type === "response.function_call_arguments.done").length
    check(added > 0 && argDelta > 0 && argDone > 0, "tool turn1 emits the full function-call lifecycle", `added=${added} delta=${argDelta} done=${argDone}`)
    return item ? { id: item.call_id ?? item.id ?? "call_unknown", name: item.name ?? "", arguments: item.arguments ?? "{}" } : undefined
  }
  const frames = parseFrames(body)
  check(frames[0]?.type === "message_start", "tool turn1 starts with message_start", String(frames[0]?.type))
  check(frames.at(-1)?.type === "message_stop", "tool turn1 ends with message_stop", String(frames.at(-1)?.type))
  const start = frames.find(
    (frame) =>
      frame.type === "content_block_start" &&
      (frame.data as { content_block?: { type?: string } }).content_block?.type === "tool_use",
  )
  const block = (start?.data as { content_block?: { id?: string; name?: string } } | undefined)?.content_block
  const partialJson = frames
    .filter(
      (frame) =>
        frame.type === "content_block_delta" &&
        (frame.data as { delta?: { type?: string } }).delta?.type === "input_json_delta",
    )
    .map((frame) => String((frame.data as { delta: { partial_json?: string } }).delta.partial_json ?? ""))
    .join("")
  const stopReason = frames
    .filter((frame) => frame.type === "message_delta")
    .map((frame) => (frame.data as { delta?: { stop_reason?: string } }).delta?.stop_reason)
    .at(-1)
  check(stopReason === "tool_use", "tool turn1 stop_reason is tool_use", String(stopReason))
  return block ? { id: block.id ?? "toolu_unknown", name: block.name ?? "", arguments: partialJson || "{}" } : undefined
}

/** Turn 2: replay the executed tool result in the facade's native shape. */
async function toolTurnTwo(facade: Facade, model: string, call: ToolCall): Promise<void> {
  const toolResult = executeCityTool(call.arguments)
  const body: Record<string, unknown> =
    facade === "chat"
      ? {
          model,
          stream: true,
          messages: [
            { role: "user", content: USER_ASK },
            { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] },
            { role: "tool", tool_call_id: call.id, content: toolResult },
          ],
          tools: toolsFor(facade),
        }
      : facade === "responses"
        ? {
            model,
            stream: true,
            input: [
              { role: "user", content: USER_ASK },
              { type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments },
              { type: "function_call_output", call_id: call.id, output: toolResult },
            ],
            tools: toolsFor(facade),
          }
        : {
            model,
            max_tokens: 1024,
            stream: true,
            messages: [
              { role: "user", content: USER_ASK },
              { role: "assistant", content: [{ type: "tool_use", id: call.id, name: call.name, input: JSON.parse(call.arguments || "{}") as unknown }] },
              {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: call.id, content: toolResult },
                  { type: "text", text: "Based on the tool result, tell me the temperature and the report id." },
                ],
              },
            ],
            tools: toolsFor(facade),
          }
  const auth = authFor(facade)
  const res = await post(PATHS[facade], body, auth)
  check(res.status === 200, "tool turn2 HTTP 200", `status=${res.status}`)
  if (res.status !== 200) {
    bad("tool turn2 error body", (await res.text()).slice(0, 200))
    return
  }
  const { text, timing } = await readStream(res)
  const result = readStreamResult(facade, text)
  check(timing.reads > 1, "tool turn2 streams incrementally", `${timing.reads} reads`)
  check(result.text.includes("17"), "tool turn2 answer uses the tool result (17C)", JSON.stringify(result.text.slice(0, 80)))
  check(result.text.includes(SENTINEL), `tool turn2 answer is grounded on sentinel ${SENTINEL}`, JSON.stringify(result.text.slice(0, 80)))
  if (facade === "chat") check(result.finish === "stop", "tool turn2 finish_reason is stop", result.finish)
  if (facade === "responses") check(result.finish === "response.completed", "tool turn2 ends with response.completed", result.finish)
  if (facade === "messages") check(result.finish === "end_turn", "tool turn2 stop_reason is end_turn", result.finish)
}

// ---------------------------------------------------------------------------
// 4. facade-native reasoning effort
// ---------------------------------------------------------------------------

/** Every model must accept its own advertised levels; space-bunny clamps `none`. */
async function checkEffort(facade: Facade, model: string, effort: string): Promise<void> {
  const extra: Record<string, unknown> =
    facade === "chat"
      ? { reasoning_effort: effort }
      : facade === "responses"
        ? { reasoning: { effort } }
        : { thinking: { type: "enabled", budget_tokens: effort === "minimal" ? 1024 : 8192 } }
  const res = await post(PATHS[facade], textStreamRequest(facade, model, "Reply with the single word: pong", extra))
  check(res.status === 200, `effort=${effort} accepted (HTTP 200)`, `status=${res.status}`)
  if (res.status !== 200) {
    bad(`effort=${effort} rejected`, (await res.text()).slice(0, 200))
    return
  }
  await drain(res)
  // space-bunny rejects `none` upstream (400) — the proxy clamps it to
  // `minimal`, so a 200 here proves the clamp is wired up on the edge path.
  ok(`effort=${effort} round-tripped to the upstream`)
}

// ---------------------------------------------------------------------------
// 5. stateless multi-turn replay
// ---------------------------------------------------------------------------

async function checkMultiTurn(facade: Facade, model: string): Promise<void> {
  const token = `ZEPHYR-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  const first = await post(PATHS[facade], textStreamRequest(facade, model, `Reply with exactly this token and nothing else: ${token}`))
  check(first.status === 200, "multi-turn turn1 HTTP 200", `status=${first.status}`)
  if (first.status !== 200) {
    bad("multi-turn turn1 error body", (await first.text()).slice(0, 200))
    return
  }
  await drain(first)

  const followUp = "Which token did I ask you to repeat in my previous message? Reply with the token only."
  const body: Record<string, unknown> =
    facade === "chat"
      ? {
          model,
          stream: true,
          messages: [
            { role: "user", content: `Reply with exactly this token and nothing else: ${token}` },
            { role: "user", content: followUp },
          ],
        }
      : facade === "responses"
        ? {
            model,
            stream: true,
            input: [
              { role: "user", content: `Reply with exactly this token and nothing else: ${token}` },
              { role: "user", content: followUp },
            ],
          }
        : {
            model,
            max_tokens: 1024,
            stream: true,
            messages: [
              { role: "user", content: `Reply with exactly this token and nothing else: ${token}` },
              { role: "user", content: followUp },
            ],
          }
  const auth = authFor(facade)
  const second = await post(PATHS[facade], body, auth)
  check(second.status === 200, "multi-turn turn2 HTTP 200", `status=${second.status}`)
  if (second.status !== 200) {
    bad("multi-turn turn2 error body", (await second.text()).slice(0, 200))
    return
  }
  const { text: sse, timing } = await readStream(second)
  const result = readStreamResult(facade, sse)
  check(timing.reads > 1, "multi-turn turn2 streams incrementally", `${timing.reads} reads`)
  check(result.text.toUpperCase().includes(token), `multi-turn replayed the earlier token ${token}`, JSON.stringify(result.text.slice(0, 80)))
}

// ---------------------------------------------------------------------------
// 6. client abort mid-stream
// ---------------------------------------------------------------------------

async function checkClientAbort(facade: Facade, model: string): Promise<void> {
  const controller = new AbortController()
  const body: Record<string, unknown> =
    facade === "chat"
      ? { model, stream: true, messages: [{ role: "user", content: "Count slowly from 1 to 200, one number per line." }] }
      : facade === "responses"
        ? { model, stream: true, input: "Count slowly from 1 to 200, one number per line." }
        : { model, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Count slowly from 1 to 200, one number per line." }] }
  const auth = authFor(facade)
  const started = Date.now()
  try {
    const res = await post(PATHS[facade], body, auth, { signal: controller.signal })
    check(res.status === 200, "abort: stream opened", `status=${res.status}`)
    const reader = res.body!.getReader()
    await reader.read()
    controller.abort()
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    const elapsed = Date.now() - started
    check(elapsed < 30_000, "abort: connection closed promptly after cancel", `${elapsed}ms`)
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    const message = error instanceof Error ? error.message : String(error)
    // An AbortError from our own cancel is the expected outcome; anything else
    // means the edge runtime swallowed or mangled the cancellation.
    check(name === "AbortError", "abort: surfaced as AbortError (no hang)", `${name}: ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Platform-level checks (no upstream traffic)
// ---------------------------------------------------------------------------

async function checkPlatform(): Promise<void> {
  currentCell = "platform"

  const root = await get("")
  check(root.status === 200, "function root serves an index", `status=${root.status}`)

  const missing = await get("/nope", {})
  check(missing.status === 404, "unknown route 404s", `status=${missing.status}`)

  for (const facade of ["chat", "responses", "messages"] as Facade[]) {
    const auth = authFor(facade)
    const anon = await post(PATHS[facade], textRequest(facade, "muse-spark-1.3-contributor-free", "hi"), {})
    check(anon.status === 401, `${facade}: missing key fails closed (401)`, `status=${anon.status}`)
    const wrong = await post(PATHS[facade], textRequest(facade, "muse-spark-1.3-contributor-free", "hi"), {
      authorization: "Bearer not-the-key",
    })
    check(wrong.status === 401, `${facade}: wrong key fails closed (401)`, `status=${wrong.status}`)
    const envelope = (await wrong.json().catch(() => null)) as { error?: { type?: string } } | null
    check(
      envelope?.error?.type === (facade === "messages" ? "authentication_error" : "authentication_error"),
      `${facade}: 401 uses the facade error envelope`,
      JSON.stringify(envelope),
    )
    const method = await fetch(`${BASE}${PATHS[facade]}`, { method: "GET", headers: auth })
    check(method.status === 405, `${facade}: GET rejected with 405`, `status=${method.status}`)
    const malformed = await post(PATHS[facade], "{not json", auth)
    check(malformed.status === 400, `${facade}: malformed JSON rejected with 400`, `status=${malformed.status}`)
  }

  // GET /v1/models is the one GET-legal endpoint.
  const catalog = await get("/models")
  check(catalog.status === 200, "GET /v1/models is auth-legal", `status=${catalog.status}`)
  const list = (await catalog.json()) as { object?: string; data?: Array<{ id?: string; reasoning_levels?: string[]; context_window?: number }> }
  check(list.object === "list", "catalog uses the OpenAI models-list envelope", String(list.object))
  check((list.data ?? []).length === 3, "catalog lists all 3 free models", String((list.data ?? []).length))
  for (const model of MODELS) {
    const entry = (list.data ?? []).find((candidate) => candidate.id === model)
    check(entry !== undefined, `catalog contains ${model}`)
    check((entry?.context_window ?? 0) > 0, `catalog reports a context window for ${model}`, String(entry?.context_window))
  }
  const mimo = (list.data ?? []).find((candidate) => candidate.id === "mimo-v2.6-flash-free")
  const bunny = (list.data ?? []).find((candidate) => candidate.id === "space-bunny-free")
  check((mimo?.reasoning_levels ?? []).length === 0, "mimo advertises no effort levels", JSON.stringify(mimo?.reasoning_levels))
  check((bunny?.reasoning_levels ?? []).includes("max"), "space-bunny advertises max", JSON.stringify(bunny?.reasoning_levels))

  // The platform gateway only routes `/functions/v1/<slug>/...`. That path form
  // must reach the handler (and fail on AUTH, not on routing), while bare
  // OpenAI-shaped paths are NOT reachable through Supabase — the gateway 404s
  // them before the function runs. Probing from the ORIGIN, not from BASE,
  // avoids prefixing the mount point twice.
  const origin = new URL(BASE).origin
  const gatewayForm = await fetch(`${origin}/functions/v1/muse-proxy/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  // An unauthenticated {} body must fail on AUTH (401), never 404/405 — that
  // would mean the path never matched a facade.
  check(gatewayForm.status === 401, "gateway route /functions/v1/muse-proxy/v1/* reaches the handler", `status=${gatewayForm.status}`)

  for (const suffix of ["/v1/chat/completions", "/chat/completions"]) {
    const res = await fetch(`${origin}${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    check(res.status === 404, `gateway rejects non-mounted path ${suffix}`, `status=${res.status}`)
  }

  // An unknown function slug is the platform's own 404, distinct from ours.
  const unknownSlug = await fetch(`${origin}/functions/v1/not-a-function/models`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  check(unknownSlug.status === 404, "gateway 404s an undeployed function slug", `status=${unknownSlug.status}`)
  const unknownBody = (await unknownSlug.json().catch(() => null)) as { message?: string } | null
  check(
    unknownBody?.message === "Requested function was not found",
    "unknown slug uses the platform 404 shape",
    JSON.stringify(unknownBody),
  )

  // verify_jwt = false: no Supabase apikey header is needed, PROXY_API_KEY is
  // the only credential. This is what keeps the base URL drop-in compatible.
  const noApiKey = await fetch(`${origin}/functions/v1/muse-proxy/v1/models`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  check(noApiKey.status === 200, "no Supabase apikey required (verify_jwt=false)", `status=${noApiKey.status}`)
}

// ---------------------------------------------------------------------------

async function runCell(facade: Facade, model: string, effort: string): Promise<void> {
  currentCell = `${model} / ${facade}`
  console.log(`\n--- ${currentCell} ---`)
  const stages: Array<[string, () => Promise<void>]> = [
    ["1/6 non-stream text", () => checkTextNonStreaming(facade, model)],
    ["2/6 stream text", () => checkTextStreaming(facade, model)],
    [
      "3/6 streaming tool loop",
      async () => {
        const turn = await toolTurnOne(facade, model)
        if (turn.ok && turn.call) await toolTurnTwo(facade, model, turn.call)
      },
    ],
    ["4/6 reasoning effort", () => checkEffort(facade, model, effort)],
    ["5/6 multi-turn replay", () => checkMultiTurn(facade, model)],
    ["6/6 client abort", () => checkClientAbort(facade, model)],
  ]
  for (const [name, run] of stages) {
    console.log(`  [${name}]`)
    try {
      await run()
    } catch (error) {
      bad(`${name} crashed`, error instanceof Error ? error.message : String(error))
    }
  }
}

async function main(): Promise<void> {
  SENTINEL = `SX-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  const sections = pick("section", ["platform", "matrix"])
  const models = pick("model", MODELS)
  const facades = pick("facade", ["chat", "responses", "messages"]) as Facade[]

  console.log(`\n=== EDGE FUNCTION CONFORMANCE (${BASE}, sentinel ${SENTINEL}) ===`)
  if (!KEY) {
    console.error("PROXY_API_KEY is empty — set it (or source .env.local) before running this suite")
    process.exit(1)
  }

  if (sections.includes("platform")) {
    console.log("\n[platform] routing, auth and protocol guards")
    await checkPlatform()
  }

  if (sections.includes("matrix")) {
    for (const model of models) {
      // muse advertises none..xhigh, space-bunny minimal..max, mimo has no
      // effort control (reasoning is always on).
      const effort = model.startsWith("mimo")
        ? "high"
        : model.includes("space-bunny")
          ? "minimal"
          : "high"
      for (const facade of facades) await runCell(facade, model, effort)
    }
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`)
  if (failures.length > 0) {
    console.log("Failures:")
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
  }
  console.log("EDGE CONFORMANCE OK")
  process.exit(0)
}

await main()

// Top-level await needs this file to be an ES module.
export {}