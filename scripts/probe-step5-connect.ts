// Diagnostic probe (not part of the test suite): capture the FULL SSE
// vocabulary of step-5-preview-free on the zen oa-compat edge.
// Usage: bun run scripts/probe-step5-connect.ts
import * as fs from "node:fs"
import { lowerChatUpstream } from "../api/_lib/chat-upstream"
import { identityForCall } from "../api/_lib/identity"
import { OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_USER_AGENT, type ModelInfo } from "../api/_lib/types"

const OA_COMPAT_URL = "https://opencode.ai/zen/v1/chat/completions"

const STEP5_INFO: ModelInfo = {
  id: "step-5-preview-free",
  name: "Step 5 Preview Free",
  upstream: "oa-compat",
  description: "probe",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_000,
  efforts: [],
}

const identity = identityForCall("probe-step5-connect")
const body = lowerChatUpstream({
  model: STEP5_INFO,
  input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: PONG" }] }],
  tools: [],
  maxOutputTokens: 512,
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
console.log("status:", res.status)
const text = await res.text()
fs.writeFileSync("/tmp/step5-raw.sse", text)

const lines = text.split("\n").filter((l) => l.startsWith("data:"))
console.log("total data frames:", lines.length)
let content = ""
let reasoning = ""
let finishes = new Set<string>()
let framesWithoutChoices = 0
let lastFrames: string[] = []
for (const line of lines) {
  const payload = line.slice(5).trim()
  if (payload === "[DONE]") {
    console.log("[DONE] present")
    continue
  }
  try {
    const chunk = JSON.parse(payload) as Record<string, unknown>
    const choices = chunk.choices as Array<Record<string, unknown>> | undefined
    if (!choices || choices.length === 0) {
      framesWithoutChoices++
      if (lastFrames.length < 5) lastFrames.push(payload)
      if ("usage" in chunk) console.log("USAGE FRAME:", JSON.stringify(chunk.usage))
      continue
    }
    for (const c of choices) {
      const delta = (c.delta ?? c.message) as Record<string, unknown> | undefined
      if (!delta) continue
      if (typeof delta.content === "string") content += delta.content
      if (typeof delta.reasoning === "string") reasoning += delta.reasoning
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content
      if (typeof c.finish_reason === "string" && c.finish_reason) finishes.add(c.finish_reason)
    }
  } catch {}
}
console.log("content:", JSON.stringify(content))
console.log("reasoning length:", reasoning.length, "preview:", JSON.stringify(reasoning.slice(0, 80)))
console.log("finish reasons:", [...finishes])
console.log("frames without choices:", framesWithoutChoices, lastFrames.map((f) => f.slice(0, 150)))
