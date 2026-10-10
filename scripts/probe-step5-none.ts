// Diagnostic probe: matrix of (prompt, effort) for step-5-preview-free on the
// real edge to pin down when "Reasoning is mandatory" 400s.
// Usage: bun run scripts/probe-step5-none.ts
import { lowerChatUpstream } from "../api/_lib/chat-upstream"
import { identityForCall } from "../api/_lib/identity"
import { resolveModel, OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_USER_AGENT } from "../api/_lib/types"

const OA_COMPAT_URL = "https://opencode.ai/zen/v1/chat/completions"
const model = resolveModel("step-5-preview-free")

async function send(effort: string | undefined, prompt: string, label: string) {
  const identity = identityForCall(`matrix-${label}`)
  const body = lowerChatUpstream({
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [],
    effort,
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
    signal: AbortSignal.timeout(90_000),
  })
  const text = await res.text()
  let summary = res.ok ? "" : text.replace(/\s+/g, " ").slice(0, 130)
  if (res.ok) {
    let content = ""
    let reasoning = 0
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (payload === "[DONE]") break
      try {
        const c = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string; reasoning?: string } }> }
        content += c.choices?.[0]?.delta?.content ?? ""
        reasoning += (c.choices?.[0]?.delta?.reasoning ?? "").length
      } catch {}
    }
    summary = `text="${content.slice(0, 30)}" reasoningChars=${reasoning}`
  }
  console.log(`[${label}] effort=${effort ?? "(absent)"} -> ${res.status} ${summary}`)
}

const cases: Array<[string | undefined, string, string]> = [
  [undefined, "Reply with exactly: OK", "absent-okprompt"],
  ["none", "Reply with exactly: OK", "none-okprompt"],
  ["none", "What is 12 * 12? Reply with just the number.", "none-mathprompt"],
  ["minimal", "Reply with exactly: OK", "minimal-okprompt"],
  ["high", "Reply with exactly: OK", "high-okprompt"],
]
for (const [effort, prompt, label] of cases) {
  await send(effort, prompt, label)
  await new Promise((r) => setTimeout(r, 1500))
}
