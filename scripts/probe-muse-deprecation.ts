// Diagnostic probe (not part of the test suite): verify today's upstream model
// availability. muse-spark free ids became "deprecated" at the zen edge, while
// the openai-compatible free models moved provider.api to
// /inference/openai/v1 (models.opencode.ai/api.json). This probe posts a
// gate-passing body for each candidate to the three live endpoints so we can
// pick the replacement route from real responses, not guesses:
//
//   (A) /inference/v1/chat/completions   (current oa-compat route)
//   (B) /inference/openai/v1/chat/completions  (new catalog provider.api)
//   (C) /inference/v1/responses          (former muse route)
//
// Usage: bun run scripts/probe-muse-deprecation.ts [model ...]
import { lowerChatUpstream } from "../api/_lib/chat-upstream.js"
import { identityForCall } from "../api/_lib/identity.js"
import { lowerRequest } from "../api/_lib/lower.js"
import {
  OPENCODE_CLIENT,
  OPENCODE_PROJECT_ID,
  UPSTREAM_API_KEY,
  UPSTREAM_URL,
  UPSTREAM_USER_AGENT,
  type ModelInfo,
} from "../api/_lib/types.js"
import { appendClientTools } from "../api/_lib/tools.js"

const OA_COMPAT_URL = "https://opencode.ai/inference/v1/chat/completions"
const OPENAI_NEW_URL = "https://opencode.ai/inference/openai/v1/chat/completions"

const MODELS =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [
        "nemotron-3.5-super-vl-free",
        "beam-free",
        "nemotron-3.5-lightning-free",
        "nemotron-3-ultra-free",
        "longcat-2.5-preview-free",
        "big-pickle",
        "muse-spark-1.3-contributor-free",
      ]

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
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      if (typeof delta?.content === "string") out += delta.content
      if (typeof delta?.reasoning_content === "string") reasonings.push(delta.reasoning_content)
      if (typeof delta?.reasoning === "string") reasonings.push(delta.reasoning)
    } catch {
      /* non-JSON frame */
    }
  }
  return `text="${out.slice(0, 60)}" reasoning_chars=${reasonings.join("").length}`
}

const uaCompatId = (model: string): ModelInfo => ({
  id: model,
  name: model,
  upstream: "oa-compat",
  description: "probe",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  efforts: [],
})

for (const model of MODELS) {
  for (const [label, url] of [
    ["chat(A) /inference/v1", OA_COMPAT_URL],
    ["chat(B) /inference/openai/v1", OPENAI_NEW_URL],
  ] as const) {
    const identity = identityForCall(`probe-${model}-${label}`)
    const body = lowerChatUpstream({
      model: uaCompatId(model),
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: PONG" }] }],
      tools: appendClientTools([]),
      maxOutputTokens: 512,
    })
    const res = await fetch(url, {
      method: "POST",
      headers: upstreamHeaders(identity),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const text = await res.text()
    console.log(`[${model}] ${label} -> ${res.status} ${res.ok ? preview(text) : text.replace(/\s+/g, " ").slice(0, 200)}`)
  }
  {
    const identity = identityForCall(`probe-resp-${model}`)
    const lowered = lowerRequest(
      { stream: false, messages: [{ role: "user", content: "Reply with exactly: PONG" }], reasoning_effort: "low" },
      { sessionId: identity.sessionId },
    )
    if ("error" in lowered) {
      console.log(`[${model}] responses(C) -> LOWER ERROR ${lowered.error}`)
    } else {
      const res = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers: upstreamHeaders(identity),
        body: JSON.stringify({ ...lowered.request, model }),
        signal: AbortSignal.timeout(120_000),
      })
      const text = await res.text()
      console.log(
        `[${model}] responses(C) /inference/v1/responses -> ${res.status} ${
          res.ok ? preview(text) : text.replace(/\s+/g, " ").slice(0, 200)
        }`,
      )
    }
  }
}
