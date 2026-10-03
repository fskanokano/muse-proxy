// Probe (not part of the test suite): bisect the space-bunny-free upstream
// 400 ("invalid_request_error: invalid request") one item at a time over the
// exact request the PROXY would send. Baseline = lowerChatUpstream(muse-info
// trick to get a plain Responses-shaped input), then each variant flips ONE
// field back toward what a real agent sends. 200 = innocent; 400 = culprit
// found (network required).
// Usage: bun run scripts/probe-spacebunny-bisect.ts
//
// NOTE on the muse-info trick: handleChatRequest routes via resolveModel()
// BEFORE lowering, so the chat facade always lowers with the full Responses
// shape (content arrays with input_text parts, tool_call items, etc.) and
// then converts to chat messages in lowerChatUpstream. To bisect the exact
// proxy wire shape we call lowerChatUpstream directly with a ModelInfo-shaped
// object and the same kinds of input items the muse path produces.

import { lowerChatUpstream } from "../supabase/functions/v1/_lib/chat-upstream.ts"
import { identityForCall } from "../supabase/functions/v1/_lib/identity.ts"
import { OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_USER_AGENT, type UpstreamTool } from "../supabase/functions/v1/_lib/types.ts"

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
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }

function baseItems(): Item[] {
  return [
    { role: "system", content: "You are a senior front-end engineer creating a single-file HTML page." },
    { role: "user", content: [{ type: "input_text", text: "写一个 HTML 页面:企鹅骑自行车的 SVG 动画。先输出完整代码。" }] },
    { role: "assistant", content: [{ type: "output_text", text: synthHtml(20_000) }] },
    { role: "user", content: [{ type: "input_text", text: "加一个深色模式变体,更新完整代码。" }] },
    { role: "assistant", content: [{ type: "output_text", text: synthHtml(20_000) }] },
    { role: "user", content: [{ type: "input_text", text: "用 50 字总结动画实现要点,不要输出代码。" }] },
  ]
}

const CLIENT_TOOL: UpstreamTool = {
  type: "function",
  name: "memory_get",
  description: "Look up stored memory by keywords.",
  parameters: { type: "object", properties: { keywords: { type: "array", items: { type: "string" } } }, required: ["keywords"] },
}

interface Variant {
  name: string
  items: Item[]
  effort?: string
  tools?: typeof CLIENT_TOOL[]
  maxTokens?: number
}

function variants(): Variant[] {
  const base = baseItems()
  const list: Variant[] = [
    { name: "00 baseline (40k assistant history, no tools, no effort)", items: base },
  ]

  // 1. effort ladder
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    list.push({ name: `effort=${effort}`, items: base, effort })
  }

  // 2. client tool
  list.push({ name: "client tool present", items: base, tools: [CLIENT_TOOL] })
  list.push({ name: "client tool + effort=max", items: base, tools: [CLIENT_TOOL], effort: "max" })

  // 3. tool-call replay round inserted between the two big assistant turns.
  const withReplay: Item[] = [
    base[0]!,
    base[1]!,
    base[2]!,
    { type: "function_call", call_id: "call_probe_1", name: "memory_get", arguments: "{\"keywords\":[\"html\",\"svg\",\"动画\",\"设计偏好\"]}" },
    { type: "function_call_output", call_id: "call_probe_1", output: JSON.stringify({ matches: [], note: "no entries found" }) },
    base[3]!,
    base[4]!,
    base[5]!,
  ]
  list.push({ name: "function_call + function_call_output replay", items: withReplay })
  list.push({ name: "replay + client tool", items: withReplay, tools: [CLIENT_TOOL] })
  list.push({ name: "replay + client tool + effort=max", items: withReplay, tools: [CLIENT_TOOL], effort: "max" })

  // 4. effort none (space-bunny should clamp to minimal in the proxy)
  list.push({ name: "effort=none", items: base, effort: "none" })

  // 5. max_tokens huge (agent SDKs send large values)
  list.push({ name: "max_tokens=32000", items: base, maxTokens: 32_000 })
  list.push({ name: "max_tokens=32000 + effort=max", items: base, effort: "max", maxTokens: 32_000 })

  return list
}

async function fire(name: string, items: Item[], effort?: string, tools?: typeof CLIENT_TOOL[], maxTokens?: number): Promise<void> {
  const identity = identityForCall(`bisect-${Math.random().toString(36).slice(2, 8)}`)
  const body = lowerChatUpstream({
    model: MODEL_INFO,
    input: items,
    tools: tools ?? [],
    effort,
    maxOutputTokens: maxTokens,
  })
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
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const text = await res.text()
    console.log(`  ${name}: HTTP ${res.status} — ${text.replace(/\s+/g, " ").slice(0, 240)}`)
    return
  }
  const text = await res.text()
  let sawError = ""
  for (const line of text.split("\n")) {
    if (!line.includes("\"error\"")) continue
    sawError = line.replace(/\s+/g, " ").slice(0, 200)
    break
  }
  console.log(`  ${name}: 200${sawError ? ` (in-stream: ${sawError})` : ""}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log(`=== space-bunny BISECT on the exact proxy wire shape (model=${MODEL}) ===`)
for (const v of variants()) {
  try {
    await fire(v.name, v.items, v.effort, v.tools, v.maxTokens)
  } catch (error) {
    console.log(`  ${v.name}: FETCH FAILED — ${String(error).slice(0, 160)}`)
  }
  await sleep(1200)
}
console.log("done")
