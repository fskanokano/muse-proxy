// Probe: does the muse Responses upstream accept reasoning.effort "max"?
import { lowerRequest } from "../supabase/functions/v1/_lib/lower.ts"
import { identityForCall } from "../supabase/functions/v1/_lib/identity.ts"
import { OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_URL, UPSTREAM_USER_AGENT } from "../supabase/functions/v1/_lib/types.ts"

for (const effort of ["xhigh", "max"]) {
  const identity = identityForCall(`probe-muse-effort-${effort}`)
  const lowered = lowerRequest({
    stream: false,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    reasoning_effort: effort,
  }, { sessionId: identity.sessionId })
  if ("error" in lowered) {
    console.log(`[${effort}] LOWER ERROR`, lowered.error)
    continue
  }
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
    body: JSON.stringify({ ...lowered.request, reasoning: { ...lowered.request.reasoning, effort } }),
    signal: AbortSignal.timeout(60_000),
  })
  if (res.ok) {
    const text = await res.text()
    const usage = text.split("\n").find((l) => l.includes("total_tokens"))
    console.log(`[${effort}] ${res.status} OK ${usage ? "(completed)" : "(streamed)"}`)
  } else {
    const text = await res.text()
    console.log(`[${effort}] ${res.status}`, text.replace(/\s+/g, " ").slice(0, 160))
  }
  await new Promise((r) => setTimeout(r, 1500))
}
