// Probe (not part of the test suite): the 400s happen DURING the response
// (request acceptance is always 200 — proven by the budget matrix). This
// probe replays real FULL-code turns (the field killer: "输出更新后的完整
// HTML 代码") through the exact proxy wire shape and inspects the RAW SSE
// event stream of turn 2+ for malformed chunks (network required).
// Usage: bun run scripts/probe-spacebunny-stream.ts
//
// Checks per turn:
//   - every data: line parses as JSON
//   - [DONE] present; nothing after [DONE]
//   - usage chunk shape sane
//   - the trailing choices:[] cost frame (documented oa-compat quirk) noted
//   - first/last content chunk preview

import { lowerChatUpstream } from "../supabase/functions/v1/_lib/chat-upstream.ts"
import { identityForCall } from "../supabase/functions/v1/_lib/identity.ts"
import { OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_USER_AGENT } from "../supabase/functions/v1/_lib/types.ts"

const OA_COMPAT_URL = "https://opencode.ai/zen/v1/chat/completions"
const MODEL = process.env.PROBE_MODEL ?? "space-bunny-free"

const MODEL_INFO = {
  id: MODEL,
  name: MODEL,
  upstream: "oa-compat" as const,
  description: "",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_000,
  efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
}

type Item =
  | { role: "system"; content: string }
  | { role: "user"; content: Array<{ type: "input_text"; text: string }> }
  | { role: "assistant"; content: Array<{ type: "output_text"; text: string }> }

const SHORT_ASK = "用 20 字总结动画要点,不要输出代码。"
const FULL_ASK = "输出更新后的完整 HTML 代码(从 <!DOCTYPE html> 到 </html>,不要省略)。"

interface TurnOutcome {
  ok: boolean
  content: string
  finish: string
  anomalies: string[]
  chunkCount: number
}

async function streamTurn(messages: unknown[], label: string): Promise<TurnOutcome> {
  const body = lowerChatUpstream({
    model: MODEL_INFO,
    input: messages as never,
    tools: [],
  })
  const identity = identityForCall(`stream-${Math.random().toString(36).slice(2, 8)}`)
  const res = await fetch(OA_COMPAT_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${UPSTREAM_API_KEY}`,
      "content-type": "application/json",
      accept: "*/*",
      "user-agent": UPSTREAM_USER_AGENT,
      "x-opencode-session": identity.sessionId,
      "x-opencode-request": identity.requestId,
      "x-opencode-client": OPENCODE_CLIENT,
      "x-opencode-project": OPENCODE_PROJECT_ID,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
  })
  if (!res.ok) {
    const text = await res.text()
    console.log(`  ${label}: HTTP ${res.status} — ${text.replace(/\s+/g, " ").slice(0, 240)}`)
    return { ok: false, content: "", finish: "", anomalies: [`HTTP ${res.status}`], chunkCount: 0 }
  }
  const text = await res.text()
  const lines = text.split("\n")
  const anomalies: string[] = []
  let content = ""
  let finish = ""
  let chunkCount = 0
  let doneSeen = false
  let dataAfterDone = 0
  let costFrame = 0
  let firstContent = ""
  let lastContent = ""
  for (const line of lines) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0) continue
    if (payload === "[DONE]") {
      doneSeen = true
      continue
    }
    if (doneSeen) dataAfterDone++
    let chunk: {
      choices?: Array<{ delta?: { content?: string; reasoning_content?: string; role?: string }; finish_reason?: string | null }>
      usage?: unknown
      cost?: unknown
      error?: { message?: string }
    }
    try {
      chunk = JSON.parse(payload)
    } catch {
      anomalies.push(`UNPARSEABLE LINE: ${line.slice(0, 120)}`)
      continue
    }
    chunkCount++
    if (chunk.error) anomalies.push(`in-stream error: ${chunk.error.message}`)
    if (chunk.cost !== undefined && Array.isArray(chunk.choices) && chunk.choices.length === 0) {
      costFrame++
      continue
    }
    for (const choice of chunk.choices ?? []) {
      const c = choice.delta?.content
      if (typeof c === "string" && c.length > 0) {
        if (content.length === 0) firstContent = c.slice(0, 40)
        content += c
        lastContent = c.slice(-40)
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) finish = choice.finish_reason
    }
  }
  if (!doneSeen) anomalies.push("NO [DONE] SENTINEL")
  if (dataAfterDone > 0) anomalies.push(`${dataAfterDone} data lines AFTER [DONE]`)
  console.log(`  ${label}: chunks=${chunkCount} finish=${finish || "?"} content=${content.length}ch costFrames=${costFrame}${anomalies.length > 0 ? ` ANOMALIES: ${anomalies.slice(0, 3).join(" | ")}` : ""}`)
  console.log(`      first: ${JSON.stringify(firstContent)}`)
  console.log(`      last:  ${JSON.stringify(lastContent)}`)
  return { ok: anomalies.length === 0, content, finish, anomalies, chunkCount }
}

async function main(): Promise<void> {
  console.log(`=== space-bunny STREAM-SHAPE probe (model=${MODEL}) ===`)

  console.log("\n[variant 1] assistant replays WITHOUT the code fence (strip ```html ... ```)")
  {
    const messages: unknown[] = [
      { role: "system", content: "You are a senior front-end engineer creating a single-file HTML page." },
      { role: "user", content: [{ type: "input_text", text: "写一个 HTML 页面:企鹅骑自行车的 SVG 动画。输出完整代码。" }] },
    ]
    const t1 = await streamTurn(messages, "turn1")
    if (t1.ok) {
      const stripped = t1.content.replace(/^```[a-z]*\n?/, "").replace(/\n?```\s*$/, "")
      messages.push({ role: "assistant", content: [{ type: "output_text", text: stripped }] })
      messages.push({ role: "user", content: [{ type: "input_text", text: "加一个深色模式变体,更新完整代码。" }] })
      await streamTurn(messages, "turn2")
    }
  }

  console.log("\n[variant 2] assistant replays WITH the code fence as-is (agent-faithful)")
  {
    const messages: unknown[] = [
      { role: "system", content: "You are a senior front-end engineer creating a single-file HTML page." },
      { role: "user", content: [{ type: "input_text", text: "写一个 HTML 页面:企鹅骑自行车的 SVG 动画。输出完整代码。" }] },
    ]
    const t1 = await streamTurn(messages, "turn1")
    if (t1.ok) {
      messages.push({ role: "assistant", content: [{ type: "output_text", text: t1.content }] })
      messages.push({ role: "user", content: [{ type: "input_text", text: "加一个深色模式变体,更新完整代码。" }] })
      await streamTurn(messages, "turn2")
      messages.push({ role: "user", content: [{ type: "input_text", text: SHORT_ASK }] })
      await streamTurn(messages, "turn3")
    }
  }

  console.log("done")
}

await main()
