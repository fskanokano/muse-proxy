// Diagnostic probe (not part of the test suite): build a gate-passing
// upstream body with muse-proxy's own lowerRequest + identityForCall, then
// swap ONLY the model id to see how the zen edge routes each free model.
// Usage: bun run scripts/probe-model-routing.ts [model ...]
import { lowerRequest } from "../supabase/functions/v1/_lib/lower.ts"
import { identityForCall } from "../supabase/functions/v1/_lib/identity.ts"
import { OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_URL, UPSTREAM_USER_AGENT } from "../supabase/functions/v1/_lib/types.ts"

const MODELS = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["muse-spark-1.3-contributor-free", "mimo-v2.6-flash-free", "space-bunny-free"]

for (const model of MODELS) {
  const identity = identityForCall(`probe-${model}`)
  const lowered = lowerRequest({
    stream: false,
    messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    reasoning_effort: "low",
  }, { sessionId: identity.sessionId })
  if ("error" in lowered) {
    console.log(`[${model}] LOWER ERROR`, lowered.error)
    continue
  }
  const body = { ...lowered.request, model }
  const res = await fetch(UPSTREAM_URL, {
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
  })
  const text = await res.text()
  if (!res.ok) {
    console.log(`[${model}] ${res.status}`, text.slice(0, 200))
    continue
  }
  let out = ""
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    try {
      const j = JSON.parse(line.slice(6)) as { type?: string; delta?: string }
      if (j.type === "response.output_text.delta") out += j.delta ?? ""
    } catch {}
  }
  console.log(`[${model}] 200 OK text="${out.slice(0, 60)}"`)
}
