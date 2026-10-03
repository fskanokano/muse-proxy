// Probe (not part of the test suite): reproduce the field report where
// space-bunny-free works for a few turns and then 400s with
// "invalid_request_error: invalid request" mid-conversation (network required).
// Usage: bun run scripts/probe-spacebunny-replay.ts [model ...]
//
// The harness replays what a third-party agent actually sends through the
// proxy: stream turn 1, aggregate the assistant message (content +
// reasoning_content + tool_calls), append tool results, and send turn 2 with a
// FRESH upstream identity — exactly like the proxy does per request.
//
// Scenarios (each isolated, fresh session per request):
//   A. pure-text multi-turn, assistant replays WITH reasoning_content
//   B. pure-text multi-turn, assistant replays content only
//   C. tool-loop multi-turn, assistant tool turns as {content: null, tool_calls}
//   D. tool-loop multi-turn, assistant tool turns as {content: "", tool_calls}
//   E. tool-loop with reasoning_effort "max" (the "超高" tier in the field app)
//   F. one long single turn (~6k chars) as a control

const OA_COMPAT_URL = "https://opencode.ai/zen/v1/chat/completions"
const MODELS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["space-bunny-free", "mimo-v2.6-flash-free"]

import { identityForCall } from "../supabase/functions/v1/_lib/identity.ts"
import { OPENCODE_BUILTIN_TOOLS, STUB_BUILTIN_TOOL_DESCRIPTION, appendClientTools } from "../supabase/functions/v1/_lib/tools.ts"

const BUILTIN_CHAT_TOOLS = OPENCODE_BUILTIN_TOOLS.map((tool) => ({
  type: "function" as const,
  function: { name: tool.name, description: STUB_BUILTIN_TOOL_DESCRIPTION, parameters: tool.parameters },
}))

const CLIENT_TOOL = {
  type: "function" as const,
  function: {
    name: "memory_get",
    description: "Look up stored memory by keywords. Returns matched entries.",
    parameters: {
      type: "object",
      properties: { keywords: { type: "array", items: { type: "string" } } },
      required: ["keywords"],
    },
  },
}

const BIG_SYSTEM = `You are a senior front-end engineer. Follow these design rules:\n${Array.from({ length: 40 }, (_, i) => `${i + 1}. Rule ${i + 1}: keep the design consistent, accessible, responsive, and performant; prefer semantic HTML, modern CSS, progressive enhancement, and clean component boundaries.`).join("\n")}`

function headersFor(callId: string) {
  const identity = identityForCall(callId)
  return {
    authorization: "Bearer public",
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14",
    "x-opencode-session": identity.sessionId,
    "x-opencode-request": identity.requestId,
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
  }
}

interface TurnResult {
  status: number
  error?: string
  content: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  finish: string
}

async function streamTurn(model: string, messages: unknown[], effort?: string, maxTokens = 2048): Promise<TurnResult> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    tools: [...BUILTIN_CHAT_TOOLS, CLIENT_TOOL],
    tool_choice: "auto",
    max_tokens: maxTokens,
  }
  if (effort) body.reasoning_effort = effort
  const res = await fetch(OA_COMPAT_URL, {
    method: "POST",
    headers: headersFor(`probe-${Math.random().toString(36).slice(2, 8)}`),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) {
    const text = await res.text()
    return { status: res.status, error: text.replace(/\s+/g, " ").slice(0, 300), content: "", reasoning: "", toolCalls: [], finish: "" }
  }
  const text = await res.text()
  const result: TurnResult = { status: res.status, content: "", reasoning: "", toolCalls: [], finish: "" }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === "[DONE]") continue
    let chunk: {
      choices?: Array<{
        delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }
        finish_reason?: string | null
      }>
      error?: { message?: string }
    }
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    if (chunk.error) {
      result.error = `in-stream error: ${chunk.error.message ?? JSON.stringify(chunk.error).slice(0, 200)}`
      continue
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      if (typeof delta.content === "string") result.content += delta.content
      if (typeof delta.reasoning_content === "string") result.reasoning += delta.reasoning_content
      if (typeof delta.reasoning === "string") result.reasoning += delta.reasoning
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0
        result.toolCalls[index] ??= { id: "", name: "", arguments: "" }
        if (call.id) result.toolCalls[index]!.id = call.id
        if (call.function?.name) result.toolCalls[index]!.name = call.function.name
        if (typeof call.function?.arguments === "string") result.toolCalls[index]!.arguments += call.function.arguments
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) result.finish = choice.finish_reason
    }
  }
  result.toolCalls = result.toolCalls.filter(Boolean)
  return result
}

async function runScenario(model: string, name: string, build: (turn: number) => { messages: unknown[]; effort?: string } | null): Promise<void> {
  let lastStatus = 0
  for (let turn = 1; turn <= 6; turn++) {
    const spec = build(turn)
    if (!spec) break
    const result = await streamTurn(model, spec.messages, spec.effort)
    lastStatus = result.status
    if (result.status !== 200 || result.error) {
      console.log(`  ${model} ${name}: FAIL at turn ${turn} (HTTP ${result.status}) ${result.error ?? ""}`)
      return
    }
  }
  console.log(`  ${model} ${name}: OK through turn ${turnsReached(lastStatus)} `)
}
function turnsReached(_status: number): number {
  return 6
}

async function scenarioA(model: string): Promise<void> {
  // Pure-text multi-turn; assistant replays content + reasoning_content.
  const messages: unknown[] = [{ role: "system", content: BIG_SYSTEM }]
  for (let turn = 1; turn <= 6; turn++) {
    messages.push(turn === 1 ? { role: "user", content: "用一个自然段介绍 HTML SVG 动画的优势,150 字左右。" } : { role: "user", content: `再补充一点第 ${turn} 个要点,50 字。` })
    const result = await streamTurn(model, messages)
    if (result.status !== 200 || result.error) {
      console.log(`  ${model} A(text+reasoning replay): FAIL at turn ${turn} (HTTP ${result.status}) ${result.error ?? ""}`)
      return
    }
    messages.push({ role: "assistant", content: result.content, reasoning_content: result.reasoning })
  }
  console.log(`  ${model} A(text+reasoning replay): OK 6 turns`)
}

async function scenarioB(model: string): Promise<void> {
  // Pure-text multi-turn; assistant replays content only.
  const messages: unknown[] = [{ role: "system", content: BIG_SYSTEM }]
  for (let turn = 1; turn <= 6; turn++) {
    messages.push(turn === 1 ? { role: "user", content: "用一个自然段介绍 CSS 动画的优势,150 字左右。" } : { role: "user", content: `再补充一点第 ${turn} 个要点,50 字。` })
    const result = await streamTurn(model, messages)
    if (result.status !== 200 || result.error) {
      console.log(`  ${model} B(text-only replay): FAIL at turn ${turn} (HTTP ${result.status}) ${result.error ?? ""}`)
      return
    }
    messages.push({ role: "assistant", content: result.content })
  }
  console.log(`  ${model} B(text-only replay): OK 6 turns`)
}

async function toolLoop(model: string, name: string, assistantToolTurn: "null" | "empty", effort?: string): Promise<void> {
  const messages: unknown[] = [{ role: "system", content: BIG_SYSTEM }]
  for (let turn = 1; turn <= 4; turn++) {
    messages.push({ role: "user", content: turn === 1 ? "查一下 memory 里关于前端设计偏好的记录,然后给我一个 300 字的设计建议。" : `结合刚才的结果,把建议扩充到 ${200 + turn * 100} 字,再查一次 memory。` })
    const result = await streamTurn(model, messages, effort)
    if (result.status !== 200 || result.error) {
      console.log(`  ${model} ${name}: FAIL at turn ${turn} (HTTP ${result.status}) ${result.error ?? ""}`)
      return
    }
    if (result.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: assistantToolTurn === "null" ? null : "",
        ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
        tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      })
      for (const call of result.toolCalls) {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ matches: [], note: "no entries found" }) })
      }
    } else {
      messages.push({ role: "assistant", content: result.content, ...(result.reasoning ? { reasoning_content: result.reasoning } : {}) })
    }
  }
  console.log(`  ${model} ${name}: OK 4 turns`)
}

async function scenarioF(model: string): Promise<void> {
  const long = `请输出一个完整 HTML 页面,内容如下(原样使用):\n${"设计要点说明。".repeat(700)}\n结尾加上总结。`
  const result = await streamTurn(model, [
    { role: "system", content: BIG_SYSTEM },
    { role: "user", content: long },
  ])
  if (result.status !== 200 || result.error) {
    console.log(`  ${model} F(long single turn ~${long.length} chars): FAIL (HTTP ${result.status}) ${result.error ?? ""}`)
    return
  }
  console.log(`  ${model} F(long single turn ~${long.length} chars): OK`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const model of MODELS) {
  console.log(`\n=== ${model} ===`)
  try {
    await scenarioA(model)
    await sleep(1500)
    await scenarioB(model)
    await sleep(1500)
    await toolLoop(model, "C(tool loop, content:null replay)", "null")
    await sleep(1500)
    await toolLoop(model, "D(tool loop, content:\"\" replay)", "empty")
    await sleep(1500)
    await toolLoop(model, "E(tool loop, effort=max)", "null", "max")
    await sleep(1500)
    await scenarioF(model)
  } catch (error) {
    console.log(`  probe crashed: ${String(error).slice(0, 200)}`)
  }
  await sleep(1500)
}
console.log("\ndone")
