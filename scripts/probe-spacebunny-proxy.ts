// Probe (not part of the test suite): reproduce the FIELD REPORT exactly —
// a third-party agent app drives space-bunny-free through THIS PROXY via chat
// completions, works for a few turns, then every turn 400s with
// "invalid_request_error: invalid request" (network required).
// Usage: bun run scripts/probe-spacebunny-proxy.ts
//
// The harness boots the real proxy handlers on a local port, then replays a
// realistic agent client: stream turn 1, aggregate the assistant message
// (content + reasoning_content + tool_calls), execute tool calls, append the
// tool results, and send turn 2 with the full history — exactly like an agent
// SDK does. Everything is freshly generated per turn (ids/messages), so if
// the failure is a server-side context-ban it reproduces; if it needs a
// replayed client artifact it reproduces too.
//
// Scenarios:
//   A. strict-SDK multi-turn: NO tools, NO reasoning_content replay
//   B. real-agent multi-turn: tools + reasoning_content + tool_calls replay
//      + bisect: -tools / -reasoning_content / -tool_call replay
//   C. reasoning_details replay (OpenRouter-style, chat facade echoes them)

import * as http from "node:http"
import { handleChatRequest } from "../api/chat"
import { resolveModel } from "../supabase/functions/v1/_lib/types.ts"

const PORT = 8961
const KEY = process.env.PROXY_API_KEY ?? "probe-key"
const BASE = `http://127.0.0.1:${PORT}`
const MODEL = process.env.PROBE_MODEL ?? "space-bunny-free"

// Turn-5 BISECT switch: shrink the replayed history at this depth to find
// which replayed artifact the upstream rejects. "shrink" replaces the
// accumulated history with the LAST user turn only; "" keeps the full
// history (default, reproduces).
const BISECT = process.env.PROBE_SHRINK_AT
const SHRINK = BISECT === "shrink"

// Log the upstream request the proxy lowers for this facade/model.
const TRACE = process.env.PROBE_TRACE === "1"
if (TRACE) {
  const info = resolveModel(MODEL)
  console.log(`[trace] resolved upstream=${info.upstream} model=${info.id} (trace of lowered body handled in-code below)`)
}

// Summarize one messages array for logging.
function shape(messages: unknown[]): string {
  return messages
    .map((m) => {
      const r = m as { role?: string; content?: unknown; tool_calls?: unknown[]; reasoning_content?: string }
      let kind = ""
      if (r.tool_calls !== undefined) kind += "+tool_calls"
      if (typeof r.reasoning_content === "string" && r.reasoning_content.length > 0) kind += "+reasoning"
      const len = typeof r.content === "string" ? r.content.length : 0
      return `${r.role ?? "?"}(${len}ch${kind})`
    })
    .join(" ")
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
      const response = await handleChatRequest(request, { PROXY_API_KEY: KEY })
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

interface PostOptions {
  tools?: unknown[]
  reasoningEffort?: string
}

async function post(messages: unknown[], options: PostOptions = {}): Promise<Response> {
  if (process.env.PROBE_LOG === "1") console.log(`    >> post: ${shape(messages)}`)
  let effective = messages
  if (SHRINK && messages.length > 3) {
    // Bisect: drop everything except system + the final user turn.
    effective = [messages[0], messages[messages.length - 1]]
    if (process.env.PROBE_LOG === "1") console.log(`    >> SHRUNK to: ${shape(effective)}`)
  }
  const body: Record<string, unknown> = { model: MODEL, stream: true, messages: effective }
  if (options.tools) {
    body.tools = options.tools
    body.tool_choice = "auto"
  }
  if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  })
}

interface Turn {
  content: string
  reasoning: string
  reasoningDetails: unknown
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  finish: string
  error: string | null
}

async function streamTurn(res: Response): Promise<Turn> {
  if (res.status !== 200) {
    const text = await res.text()
    return { content: "", reasoning: "", reasoningDetails: undefined, toolCalls: [], finish: "", error: `HTTP ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 260)}` }
  }
  const text = await res.text()
  const turn: Turn = { content: "", reasoning: "", reasoningDetails: undefined, toolCalls: [], finish: "", error: null }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6).trim()
    if (payload.length === 0 || payload === "[DONE]") continue
    let chunk: {
      choices?: Array<{
        delta?: { content?: string; reasoning_content?: string; reasoning_details?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }
        finish_reason?: string | null
      }>
    }
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      if (typeof delta.content === "string") turn.content += delta.content
      if (typeof delta.reasoning_content === "string") turn.reasoning += delta.reasoning_content
      if (delta.reasoning_details !== undefined) turn.reasoningDetails = delta.reasoning_details
      for (const call of delta.tool_calls ?? []) {
        if (call.id && call.function?.name) {
          turn.toolCalls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments ?? "" })
        } else if (call.function?.arguments && turn.toolCalls.length > 0) {
          turn.toolCalls[turn.toolCalls.length - 1]!.arguments += call.function.arguments
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) turn.finish = choice.finish_reason
    }
  }
  return turn
}

const SYSTEM = "You are a senior front-end engineer creating a single-file HTML page."
const TOOLS = [
  {
    type: "function",
    function: {
      name: "memory_get",
      description: "Look up stored memory by keywords.",
      parameters: { type: "object", properties: { keywords: { type: "array", items: { type: "string" } } }, required: ["keywords"] },
    },
  },
]

function logTurn(turn: number, result: Turn): boolean {
  if (result.error !== null) {
    console.log(`  turn ${turn}: FAIL — ${result.error}`)
    return false
  }
  console.log(`  turn ${turn}: ok finish=${result.finish} content=${result.content.length}ch reasoning=${result.reasoning.length}ch toolCalls=${result.toolCalls.length}`)
  return true
}

// A. Strict-SDK multi-turn: no tools, no reasoning replay.
async function scenarioA(): Promise<void> {
  console.log("\n[A] strict SDK: no tools, no reasoning_content replay")
  const messages: unknown[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: "写一个 HTML 页面,包含一个 SVG 动画:一只企鹅骑自行车。先输出 100 字以内的实现计划。" },
  ]
  for (let turn = 1; turn <= 6; turn++) {
    const result = await streamTurn(await post(messages))
    if (!logTurn(turn, result)) return
    messages.push({ role: "assistant", content: result.content })
    messages.push({ role: "user", content: turn === 1 ? "很好,现在输出完整 HTML 代码,不要省略任何部分。" : "再加一个新功能:点击自行车加速。更新完整代码。" })
  }
  console.log("  A: OK through 6 turns")
}

// B. Real-agent multi-turn: tools + reasoning_content + tool_calls replayed.
async function scenarioB(bisect?: { noTools?: boolean; noReasoning?: boolean; noToolReplay?: boolean; noContentOnToolTurns?: boolean }): Promise<void> {
  const label = bisect ? `B${JSON.stringify(bisect)}` : "B"
  console.log(`\n[${label}] agent: tools + reasoning_content + tool_calls replay${bisect ? " (bisect)" : ""}`)
  const messages: unknown[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: "先回忆一下我的设计偏好(memory),然后写一个 HTML 页面:企鹅骑自行车的 SVG 动画。" },
  ]
  const useTools = !bisect?.noTools
  for (let turn = 1; turn <= 6; turn++) {
    const result = await streamTurn(await post(messages, useTools ? { tools: TOOLS } : {}))
    if (!logTurn(turn, result)) return
    if (result.toolCalls.length > 0 && !bisect?.noToolReplay) {
      const assistant: Record<string, unknown> = {
        role: "assistant",
        content: bisect?.noContentOnToolTurns ? null : result.content,
      }
      if (!bisect?.noReasoning && result.reasoning) assistant.reasoning_content = result.reasoning
      assistant.tool_calls = result.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
      messages.push(assistant)
      for (const call of result.toolCalls) {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ matches: [], note: "no entries found" }) })
      }
    } else {
      const assistant: Record<string, unknown> = { role: "assistant", content: result.content }
      if (!bisect?.noReasoning && result.reasoning) assistant.reasoning_content = result.reasoning
      messages.push(assistant)
    }
    messages.push({ role: "user", content: turn === 1 ? "很好,现在输出完整 HTML 代码。" : "继续完善:加上深色模式和动画控制按钮,更新完整代码。" })
  }
  console.log(`  ${label}: OK through 6 turns`)
}

// C. reasoning_details replay (chat facade echoes them OpenRouter-style).
async function scenarioC(): Promise<void> {
  console.log("\n[C] reasoning_details replay")
  const messages: unknown[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: "用 50 字介绍 SVG SMIL 动画。" },
  ]
  for (let turn = 1; turn <= 4; turn++) {
    const result = await streamTurn(await post(messages))
    if (!logTurn(turn, result)) return
    const assistant: Record<string, unknown> = { role: "assistant", content: result.content }
    if (result.reasoningDetails !== undefined) assistant.reasoning_details = result.reasoningDetails
    if (result.reasoning) assistant.reasoning_content = result.reasoning
    messages.push(assistant)
    messages.push({ role: "user", content: `继续,第 ${turn + 1} 点,50 字。` })
  }
  console.log("  C: OK through 4 turns")
}

async function main(): Promise<void> {
  await startServer()
  console.log(`=== space-bunny FIELD-REPORT reproduction through the proxy (${BASE}) ===`)
  try {
    await scenarioA()
  } catch (error) {
    console.log(`  A crashed: ${String(error).slice(0, 200)}`)
  }
  try {
    await scenarioB()
  } catch (error) {
    console.log(`  B crashed: ${String(error).slice(0, 200)}`)
  }
  try {
    await scenarioC()
  } catch (error) {
    console.log(`  C crashed: ${String(error).slice(0, 200)}`)
  }
  process.exit(0)
}

await main()
