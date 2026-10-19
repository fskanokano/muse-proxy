// Free-tier catalog sweep (network required, not part of the test suite).
//
// Reads the runtime catalog (models.opencode.ai/api.json -> provider "opencode")
// and live-probes every `*-free` model id with the proxy's own fingerprint, so
// the catalog in _lib/types.ts can be re-audited in one shot whenever zen
// reshuffles the free tier.
//
// Usage: bun run scripts/probe-free-sweep.ts [model-id ...]
//   - no args -> every free id in the runtime catalog
//   - args    -> only those ids (e.g. after adding one model)
//
// What it reports per id:
//   - 200          -> live (the catalog's `status` column shows `deprecated`
//                     for ids zen has marked in place; they still answer until
//                     a hard retirement lands)
//   - 410          -> ModelDeprecated (metadata names a replacement when one
//                     exists)
//   - 400          -> "Upstream request failed: Model is unavailable."
//                     (retired in place: catalog still lists it, no traffic)
//   - 403 FreeTierError ("...abusive traffic from this network") -> the IP
//     itself is blocked from the anonymous free tier; the model may be fine,
//     re-run from another egress.
//   - other/THROW  -> surface verbatim
// Both mounts are probed for every id: chat/completions (the oa-compat route
// all free models ride) and /responses (the format the muse gate used to
// serve), so a protocol move shows up in the same run. Set SWEEP_CHAT_ONLY=1
// to skip the /responses leg when sweeping the whole catalog (halves the
// upstream calls; every free id except the muse ids answers
// ModelProtocolUnsupported there anyway).
import { lowerChatUpstream } from "../api/_lib/chat-upstream.js"
import { identityForCall } from "../api/_lib/identity.js"
import { lowerRequest } from "../api/_lib/lower.js"
import {
  OPENCODE_CLIENT,
  OPENCODE_PROJECT_ID,
  UPSTREAM_API_KEY,
  UPSTREAM_USER_AGENT,
  type ModelInfo,
} from "../api/_lib/types.js"
import { appendClientTools } from "../api/_lib/tools.js"

// The catalog's provider.api mount (models.opencode.ai/api.json, 2026-10-17
// onward). Kept separate from the runtime constants so this probe still runs
// while the implementation is being migrated.
const UPSTREAM_BASE = "https://opencode.ai/inference/openai/v1"
const CATALOG_URL = "https://models.opencode.ai/api.json"

interface CatalogModel {
  id: string
  status?: string
  reasoning_options?: Array<{ type: string; values?: string[] }>
  limit?: { context?: number; output?: number }
  provider?: { api?: string }
}

interface Catalog {
  opencode?: { models?: Record<string, CatalogModel> }
}

function headers(identity: { sessionId: string }): Record<string, string> {
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
    if (trimmed.startsWith("event: ") || trimmed.startsWith(":")) continue
    if (!trimmed.startsWith("data: ")) continue
    const payload = trimmed.slice(6).trim()
    if (payload.length === 0 || payload === "[DONE]") continue
    try {
      const chunk = JSON.parse(payload) as Record<string, unknown>
      if (chunk.error) return `INBAND-ERROR ${JSON.stringify(chunk.error).slice(0, 140)}`
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      if (typeof delta?.content === "string") out += delta.content
      if (typeof delta?.reasoning_content === "string") reasonings.push(delta.reasoning_content)
      if (typeof delta?.reasoning === "string") reasonings.push(delta.reasoning)
    } catch {
      /* non-JSON frame */
    }
  }
  return `text="${out.slice(0, 40)}" reasoning_chars=${reasonings.join("").length}`
}

const probeModel = (id: string): ModelInfo => ({
  id,
  name: id,
  upstream: "oa-compat",
  description: "probe",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  efforts: [],
})

async function probe(url: string, identity: { sessionId: string }, body: unknown): Promise<string> {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: headers(identity),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    })
    const text = await res.text()
    const detail = res.ok ? preview(text) : text.replace(/\s+/g, " ").slice(0, 170)
    return `${String(Date.now() - started).padStart(6)}ms ${res.status} ${detail}`
  } catch (error) {
    return `THROW ${String(error).slice(0, 140)}`
  }
}

const args = process.argv.slice(2)
const catalog = (await (await fetch(CATALOG_URL, { signal: AbortSignal.timeout(60_000) })).json()) as Catalog
const models = catalog.opencode?.models ?? {}
const ids =
  args.length > 0
    ? args
    : Object.keys(models).filter((id) => /free|pickle/i.test(id)).sort((a, b) => (a < b ? -1 : 1))

for (const id of ids) {
  const entry = models[id]
  const identity = identityForCall(`sweep-${id}`)
  const chat = await probe(`${UPSTREAM_BASE}/chat/completions`, identity, {
    ...lowerChatUpstream({
      model: probeModel(id),
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: PONG" }] }],
      tools: appendClientTools([]),
      maxOutputTokens: 32,
    }),
    model: id,
  })

  let responses = "(skipped: SWEEP_CHAT_ONLY=1)"
  if (process.env.SWEEP_CHAT_ONLY !== "1") {
    const respIdentity = identityForCall(`sweep-resp-${id}`)
    const lowered = lowerRequest(
      { stream: true, messages: [{ role: "user", content: "Reply with exactly: PONG" }] },
      { sessionId: respIdentity.sessionId },
    )
    responses =
      "error" in lowered
        ? `LOWER ERROR ${JSON.stringify(lowered.error)}`
        : await probe(`${UPSTREAM_BASE}/responses`, respIdentity, { ...lowered.request, model: id })
  }

  const flag = entry?.status ? `[${entry.status}]` : "[live]"
  const efforts = entry?.reasoning_options?.[0]?.values?.join("/") ?? "-"
  console.log(
    `${id.padEnd(34)} ${flag.padEnd(12)} ctx=${entry?.limit?.context ?? "?"} efforts=${efforts}\n` +
      `${"".padEnd(34)} chat ${chat}\n${"".padEnd(34)} resp ${responses}`,
  )
}
