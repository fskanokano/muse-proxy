// Probe (not part of the test suite): for each candidate reasoning_effort
// value, build a real gate-passing chat-completions request via
// lowerChatUpstream and see whether the zen oa-compat edge accepts it.
// Usage: bun run scripts/probe-reasoning-efforts.ts [model ...]
import { lowerChatUpstream } from "../supabase/functions/muse-proxy/_lib/chat-upstream.ts"
import { identityForCall } from "../supabase/functions/muse-proxy/_lib/identity.ts"
import { MODELS, OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_USER_AGENT } from "../supabase/functions/muse-proxy/_lib/types.ts"

const OA_COMPAT_URL = "https://opencode.ai/zen/v1/chat/completions"
const MODELS_TO_PROBE = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["mimo-v2.6-flash-free", "space-bunny-free"]
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const modelId of MODELS_TO_PROBE) {
  const info = MODELS[modelId]
  if (!info) {
    console.log(`[${modelId}] unknown model`)
    continue
  }
  const results: string[] = []
  for (const effort of EFFORTS) {
    const identity = identityForCall(`probe-effort-${modelId}-${effort}`)
    const body = lowerChatUpstream({
      model: info,
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
          signal: AbortSignal.timeout(60_000),
        })
        status = res.status
        if (res.status === 429) {
          await sleep(3000)
          continue
        }
        if (!res.ok) {
          const text = await res.text()
          detail = text.replace(/\s+/g, " ").slice(0, 120)
        } else {
          // Pull the usage chunk to confirm a real completion.
          const text = await res.text()
          const usageLine = text.split("\n").find((l) => l.includes("usage") && l.includes("total_tokens"))
          detail = usageLine ? "completed" : "streamed"
        }
        break
      } catch (error) {
        detail = String(error).slice(0, 80)
      }
    }
    results.push(`${effort}:${status}${status !== 200 ? ` (${detail})` : ""}`)
    await sleep(1500)
  }
  console.log(`[${modelId}] catalog_efforts=[${info.efforts.join(",")}]`)
  for (const line of results) console.log(`  ${line}`)
}
