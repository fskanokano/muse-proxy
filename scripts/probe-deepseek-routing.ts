// Diagnostic probe (not part of the test suite): find out which zen upstream
// FORMAT serves a model, by posting an otherwise gate-passing request to both
// live upstream endpoints with only the model id swapped.
//
// The zen edge routes each model by format: muse lives on /responses, the
// oa-compat free models live on /chat/completions. A wrong guess answers with
// a routing error (401 "not supported for format openai" / 500) instead of a
// completion, so one request per endpoint is enough to pick the route.
//
// Usage: bun run scripts/probe-deepseek-routing.ts [model ...]
import { lowerChatUpstream } from "../supabase/functions/muse-proxy/_lib/chat-upstream.ts"
import { identityForCall } from "../supabase/functions/muse-proxy/_lib/identity.ts"
import { lowerRequest } from "../supabase/functions/muse-proxy/_lib/lower.ts"
import {
  OPENCODE_CLIENT,
  OPENCODE_PROJECT_ID,
  UPSTREAM_API_KEY,
  UPSTREAM_URL,
  UPSTREAM_USER_AGENT,
  type ModelInfo,
} from "../supabase/functions/muse-proxy/_lib/types.ts"
import { appendClientTools } from "../supabase/functions/muse-proxy/_lib/tools.ts"

// Same endpoint swap as _lib/oa-compat.ts: /zen/v1 is gated off since
// 2026-10-14, the live client posts to /inference/v1.
const OA_COMPAT_URL = "https://opencode.ai/inference/v1/chat/completions"

const MODELS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["deepseek-v4.1-flash-free"]

// The four session-alias headers the current client sends (no
// x-opencode-request: re-adding it trips the free-tier gate).
function upstreamHeaders(identity: { sessionId: string }): Record<string, string> {
  return {
    authorization: `Bearer ${UPSTREAM_API_KEY}`,
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": UPSTREAM_USER_AGENT,
    "x-opencode-session": identity.sessionId,
    "x-opencode-session-id": identity.sessionId,
    "x-session-affinity": identity.sessionId,
    "x-session-id": identity.sessionId,
    "x-opencode-client": OPENCODE_CLIENT,
    "x-opencode-project": OPENCODE_PROJECT_ID,
  }
}

function preview(text: string): string {
  let out = ""
  const reasonings: string[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("event: ")) continue
    if (!trimmed.startsWith("data: ")) continue
    const payload = trimmed.slice(6).trim()
    if (payload.length === 0 || payload === "[DONE]") continue
    try {
      const chunk = JSON.parse(payload) as Record<string, unknown>
      const type = typeof chunk.type === "string" ? chunk.type : ""
      if (type === "response.output_text.delta" && typeof chunk.delta === "string") out += chunk.delta
      if (type === "response.reasoning_text.delta" && typeof chunk.delta === "string") reasonings.push(chunk.delta)
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      if (typeof delta?.content === "string") out += delta.content
      if (typeof delta?.reasoning === "string") reasonings.push(delta.reasoning)
      if (typeof delta?.reasoning_content === "string") reasonings.push(delta.reasoning_content)
    } catch {
      /* non-JSON frame */
    }
  }
  return `text="${out.slice(0, 60)}" reasoning_chars=${reasonings.join("").length}`
}

const EFFORTS = process.env.PROBE_EFFORTS === "1"

for (const model of MODELS) {
  const info: ModelInfo = {
    id: model,
    name: model,
    upstream: "oa-compat",
    description: "probe",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    efforts: [],
  }
  // ---- (A) oa-compat format: /inference/v1/chat/completions ----
  {
    const identity = identityForCall(`probe-oa-${model}`)
    const body = lowerChatUpstream({
      model: info,
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: PONG" }] }],
      tools: appendClientTools([]),
      maxOutputTokens: 512,
    })
    const res = await fetch(OA_COMPAT_URL, {
      method: "POST",
      headers: upstreamHeaders(identity),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const text = await res.text()
    console.log(`[${model}] oa-compat -> ${res.status} ${res.ok ? preview(text) : text.replace(/\s+/g, " ").slice(0, 200)}`)
  }
  // ---- (B) responses format: /inference/v1/responses ----
  {
    const identity = identityForCall(`probe-resp-${model}`)
    const lowered = lowerRequest(
      {
        stream: false,
        messages: [{ role: "user", content: "Reply with exactly: PONG" }],
        reasoning_effort: "low",
      },
      { sessionId: identity.sessionId },
    )
    if ("error" in lowered) {
      console.log(`[${model}] responses -> LOWER ERROR ${lowered.error}`)
    } else {
      const res = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers: upstreamHeaders(identity),
        body: JSON.stringify({ ...lowered.request, model }),
        signal: AbortSignal.timeout(120_000),
      })
      const text = await res.text()
      console.log(`[${model}] responses -> ${res.status} ${res.ok ? preview(text) : text.replace(/\s+/g, " ").slice(0, 200)}`)
    }
  }
  if (EFFORTS) {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const identity = identityForCall(`probe-effort-${model}-${effort}`)
      const body = lowerChatUpstream({
        model: info,
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: OK" }] }],
        tools: appendClientTools([]),
        effort,
        maxOutputTokens: 512,
      })
      const res = await fetch(OA_COMPAT_URL, {
        method: "POST",
        headers: upstreamHeaders(identity),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      })
      const detail = res.ok ? preview(await res.text()) : (await res.text()).replace(/\s+/g, " ").slice(0, 160)
      console.log(`  effort=${effort}: ${res.status} ${detail}`)
    }
  }
}
