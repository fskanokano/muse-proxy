// Diagnostic probe (not part of the test suite): per-value reasoning_effort
// acceptance for step-5-preview-free on the zen oa-compat edge.
// Usage: bun run scripts/probe-step5-efforts.ts
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
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const effort of EFFORTS) {
  const identity = identityForCall(`probe-step5-effort-${effort}`)
  const body = lowerChatUpstream({
    model: STEP5_INFO,
    input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: OK" }] }],
    tools: [],
    effort,
    maxOutputTokens: 512,
  })
  let status = 0
  let detail = ""
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
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
        signal: AbortSignal.timeout(90_000),
      })
      status = res.status
      if (res.status === 429) {
        await sleep(3000)
        continue
      }
      if (!res.ok) {
        detail = (await res.text()).replace(/\s+/g, " ").slice(0, 160)
      } else {
        const text = await res.text()
        const content: string[] = []
        for (const line of text.split("\n")) {
          if (!line.startsWith("data:")) continue
          const payload = line.slice(5).trim()
          if (payload === "[DONE]") break
          try {
            const c = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
            const d = c.choices?.[0]?.delta
            if (typeof d?.content === "string") content.push(d.content)
          } catch {}
        }
        detail = `text="${content.join("").slice(0, 40)}"`
      }
      break
    } catch (error) {
      detail = String(error).slice(0, 100)
    }
  }
  console.log(`${effort}: ${status}${status !== 200 ? ` (${detail})` : ` ${detail}`}`)
  await sleep(1200)
}
