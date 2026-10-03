// Probe (not part of the test suite): the field killer turn is "output the
// FULL updated code" — i.e. LARGE HISTORY + LARGE max_tokens BUDGET at the
// same time. Earlier bisects always asked for a short summary. This matrix
// flips the output budget across history sizes to catch a request-time
// "invalid request" from the space-bunny oa-compat edge (network required).
// Usage: bun run scripts/probe-spacebunny-budget.ts

import { lowerChatUpstream } from "../supabase/functions/muse-proxy/_lib/chat-upstream.ts"
import { identityForCall } from "../supabase/functions/muse-proxy/_lib/identity.ts"
import { OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_USER_AGENT } from "../supabase/functions/muse-proxy/_lib/types.ts"

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

function synthHtml(chars: number): string {
  let out = "<!DOCTYPE html>\n<html><body><svg viewBox=\"0 0 600 400\">"
  let i = 0
  while (out.length < chars) {
    i++
    out += `\n<g id="variant-${i}"><!-- 变体 ${i}: 车轮半径 ${40 + (i % 12)}px, 背景色 #%${(i * 7) % 255},${(i * 13) % 255},${(i * 29) % 255}, 动画 ${(0.6 + (i % 9) / 10).toFixed(1)}s --></g>`
  }
  return out + "\n</svg></body></html>"
}

type Item =
  | { role: "system"; content: string }
  | { role: "user"; content: Array<{ type: "input_text"; text: string }> }
  | { role: "assistant"; content: Array<{ type: "output_text"; text: string }> }

function history(assistantChars: number): Item[] {
  return [
    { role: "system", content: "You are a senior front-end engineer creating a single-file HTML page." },
    { role: "user", content: [{ type: "input_text", text: "写一个 HTML 页面:企鹅骑自行车的 SVG 动画。先输出完整代码。" }] },
    { role: "assistant", content: [{ type: "output_text", text: synthHtml(assistantChars) }] },
    { role: "user", content: [{ type: "input_text", text: "加一个深色模式变体,更新完整代码。" }] },
  ]
}

interface Case {
  name: string
  assistantChars: number
  maxTokens?: number
  ask: string
}

const SHORT_ASK = "用 20 字总结动画要点,不要输出代码。"
const FULL_ASK = "输出更新后的完整 HTML 代码(从 <!DOCTYPE html> 到 </html>,不要省略)。"

const CASES: Case[] = [
  { name: "hist40k + mt32768 + short ask", assistantChars: 40_000, maxTokens: 32_768, ask: SHORT_ASK },
  { name: "hist40k + mt16384 + short ask", assistantChars: 40_000, maxTokens: 16_384, ask: SHORT_ASK },
  { name: "hist40k + mt8192 + short ask", assistantChars: 40_000, maxTokens: 8_192, ask: SHORT_ASK },
  { name: "hist40k + no mt + short ask", assistantChars: 40_000, ask: SHORT_ASK },
  { name: "hist5k + mt32768 + short ask", assistantChars: 5_000, maxTokens: 32_768, ask: SHORT_ASK },
  { name: "hist0 + mt32768 + short ask", assistantChars: 0, maxTokens: 32_768, ask: SHORT_ASK },
  { name: "hist40k + mt32768 + FULL ask", assistantChars: 40_000, maxTokens: 32_768, ask: FULL_ASK },
  { name: "hist40k + mt8192 + FULL ask", assistantChars: 40_000, maxTokens: 8_192, ask: FULL_ASK },
]

async function fire(c: Case): Promise<void> {
  const items: Item[] = history(c.assistantChars)
  items.push({ role: "user", content: [{ type: "input_text", text: c.ask }] })
  const identity = identityForCall(`budget-${Math.random().toString(36).slice(2, 8)}`)
  const body = lowerChatUpstream({
    model: MODEL_INFO,
    input: items,
    tools: [],
    maxOutputTokens: c.maxTokens,
  })
  const started = Date.now()
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
    console.log(`  ${c.name}: HTTP ${res.status} — ${text.replace(/\s+/g, " ").slice(0, 260)}`)
    return
  }
  const text = await res.text()
  let finish = ""
  let out = 0
  let inStream = ""
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === "[DONE]") continue
    try {
      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
        error?: { message?: string }
      }
      if (chunk.error) inStream = chunk.error.message ?? "in-stream error"
      for (const choice of chunk.choices ?? []) {
        if (typeof choice.delta?.content === "string") out += choice.delta.content.length
        if (typeof choice.finish_reason === "string" && choice.finish_reason) finish = choice.finish_reason
      }
    } catch {
      // ignore
    }
  }
  console.log(`  ${c.name}: 200 finish=${finish || "?"} out=${out}ch ${Date.now() - started}ms${inStream ? ` IN-STREAM: ${inStream.slice(0, 160)}` : ""}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log(`=== space-bunny BUDGET matrix (model=${MODEL}) ===`)
for (const c of CASES) {
  try {
    await fire(c)
  } catch (error) {
    console.log(`  ${c.name}: FETCH FAILED — ${String(error).slice(0, 160)}`)
  }
  await sleep(1200)
}
console.log("done")
