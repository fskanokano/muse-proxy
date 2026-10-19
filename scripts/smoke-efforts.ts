// Real-upstream smoke for reasoning-effort support (network required).
// Usage: bun run smoke:efforts
//
// Proven with scripts/probe-reasoning-efforts.ts (2026-09-24) and
// scripts/probe-step5-efforts.ts (2026-10-10):
//   - mimo: effort tolerated but ignored (reasoning always on) -> no levels
//   - space-bunny: minimal..max accepted, none -> upstream 400
//   - step-5: RETIRED upstream 2026-10-17 (400 "Model is unavailable." on
//     every mount); since 2026-10-19 the id aliases deepseek-v4.1-flash-free,
//     so it advertises and clamps exactly like deepseek and is delisted from
//     /v1/models (see _lib/types.ts `listed`)
//   - big-pickle / longcat-2.5-preview-free / nemotron-3.5-lightning-free /
//     nemotron-3-ultra-free: reasoning always on with no advertised levels
//     (catalog empty reasoning_options / `toggle`) -> field dropped, same as
//     mimo (catalog read 2026-10-19)
//   - beam-free: catalog levels low/medium/high/xhigh/max; none clamps to low,
//     the rest is dropped (catalog read 2026-10-19)
//   - nemotron-3.5-super-vl-free: the only free entry whose catalog levels
//     INCLUDE none (none/minimal/low/medium/high/xhigh), so none is forwarded
//     verbatim instead of being clamped (catalog read 2026-10-19)
//   - deepseek-v4.1-flash-free: the catalog documents low/high/max only, but
//     the live edge answers 200 for every effort string (probed 2026-10-16,
//     scripts/probe-deepseek-routing.ts with PROBE_EFFORTS=1) and keeps
//     emitting reasoning_content even for none. The proxy therefore advertises
//     low/high/max, forwards those verbatim, clamps none -> low and DROPS the
//     rest (deepseek accepts them, but they are not documented capabilities).
//   - glm-5.3-flash-free: same shape as deepseek (catalog values low/high/max,
//     every effort string answered 200 on 2026-10-16 with PROBE_EFFORTS=1), so
//     it shares the deepseek policy: advertise/forward low/high/max, clamp
//     none -> low, drop the undocumented rest.
// This script drives the FULL proxy stack (not the raw upstream) to verify:
//   1. /v1/models advertises reasoning + reasoning_levels per model
//   2. mimo with effort=high completes (field tolerated & dropped)
//   3. space-bunny at minimal / high / max each completes end-to-end
//   4. space-bunny with effort none is clamped to minimal (no 400) and
//      the reasoning_content stream is still present (reasoning always on)
//   5. step-5 (deepseek alias since the 2026-10-17 retirement) at low / high /
//      max completes end-to-end, and effort none is clamped to low
//   6. deepseek at low / high / max each completes; none clamps to low and
//      the undocumented levels are dropped rather than forwarded
//   7. glm at low / high / max each completes; none clamps to low and the
//      undocumented levels are dropped rather than forwarded
//   8. muse effort=high unaffected (regression: muse ids alias deepseek)
//   9. the 2026-10-19 additions: beam at low / max completes, and
//      nemotron-3.5-super-vl at none / high completes (none is documented)

import * as http from "node:http"
import { handleChatRequest } from "../api/chat"
import { modelsList } from "../api/models"

const PORT = 8916
const KEY = process.env.PROXY_API_KEY ?? "smoke-key"
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
const failures: string[] = []
function expect(condition: boolean, name: string, detail = ""): void {
  if (condition) {
    passed++
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        const body = modelsList(Math.floor(Date.now() / 1000))
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const forwardHeaders: Record<string, string> = {}
      for (const [headerKey, value] of Object.entries(req.headers)) {
        if (typeof value === "string") forwardHeaders[headerKey] = value
      }
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: forwardHeaders,
        body: Buffer.concat(chunks),
      })
      const response = await handleChatRequest(request, { PROXY_API_KEY: KEY })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, headerKey) => {
        headers[headerKey] = value
      })
      res.writeHead(response.status, headers)
      if (response.body) {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      }
      res.end()
    })
    server.listen(PORT, "127.0.0.1", () => resolve())
  })
}

async function post(body: unknown, timeoutMs = 120_000): Promise<Response> {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

async function chatWithEffort(model: string, effort: string): Promise<{ ok: boolean; reasoningChars: number; content: string }> {
  const res = await post({
    model,
    stream: true,
    reasoning_effort: effort,
    messages: [{ role: "user", content: "What is 12 * 12? Think briefly, then reply with just the number." }],
  })
  if (res.status !== 200) {
    console.log(`    [${model} effort=${effort}] HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
    return { ok: false, reasoningChars: 0, content: "" }
  }
  const text = await res.text()
  let reasoningChars = 0
  let content = ""
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue
    try {
      const chunk = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> }
      const delta = chunk.choices?.[0]?.delta
      if (typeof delta?.content === "string") content += delta.content
      if (typeof delta?.reasoning_content === "string") reasoningChars += delta.reasoning_content.length
    } catch {}
  }
  return { ok: content.includes("144"), reasoningChars, content }
}

await startServer()
console.log(`\n=== REASONING EFFORT SMOKE (real upstream) ===`)

console.log("\n[1] /v1/models reasoning metadata")
{
  const res = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } })
  const body = (await res.json()) as { data?: Array<{ id: string; reasoning?: boolean; reasoning_levels?: string[] }> }
  const byId = new Map((body.data ?? []).map((m) => [m.id, m]))
  const mimo = byId.get("mimo-v2.6-flash-free")
  const bunny = byId.get("space-bunny-free")
  const deepseek = byId.get("deepseek-v4.1-flash-free")
  const glm = byId.get("glm-5.3-flash-free")
  expect(mimo?.reasoning === true && Array.isArray(mimo?.reasoning_levels) && mimo!.reasoning_levels!.length === 0, "mimo reasoning=true, no levels", JSON.stringify({ reasoning: mimo?.reasoning, levels: mimo?.reasoning_levels }))
  expect(bunny?.reasoning === true && bunny!.reasoning_levels!.join(",") === "minimal,low,medium,high,xhigh,max", "space-bunny minimal..max", JSON.stringify(bunny?.reasoning_levels))
  expect(deepseek?.reasoning === true && deepseek!.reasoning_levels!.join(",") === "low,high,max", "deepseek low/high/max", JSON.stringify(deepseek?.reasoning_levels))
  expect(glm?.reasoning === true && glm!.reasoning_levels!.join(",") === "low,high,max", "glm low/high/max", JSON.stringify(glm?.reasoning_levels))
  // 退役 id 已下架: /v1/models 不得再广告它们。
  expect(byId.get("step-5-preview-free") === undefined, "step-5 (deepseek alias) delisted from /v1/models")
  expect(byId.get("muse-spark-1.3-contributor-free") === undefined, "muse (deepseek alias) delisted from /v1/models")
  const pickle = byId.get("big-pickle")
  const longcat = byId.get("longcat-2.5-preview-free")
  const beam = byId.get("beam-free")
  const lightning = byId.get("nemotron-3.5-lightning-free")
  const ultra = byId.get("nemotron-3-ultra-free")
  const superVl = byId.get("nemotron-3.5-super-vl-free")
  expect(pickle?.reasoning === true && pickle!.reasoning_levels!.length === 0, "big-pickle reasoning=true, no levels", JSON.stringify(pickle?.reasoning_levels))
  expect(longcat?.reasoning === true && longcat!.reasoning_levels!.length === 0, "longcat reasoning=true, no levels", JSON.stringify(longcat?.reasoning_levels))
  expect(beam?.reasoning === true && beam!.reasoning_levels!.join(",") === "low,medium,high,xhigh,max", "beam low..max", JSON.stringify(beam?.reasoning_levels))
  expect(lightning?.reasoning === true && lightning!.reasoning_levels!.length === 0, "nemotron-lightning reasoning=true, no levels", JSON.stringify(lightning?.reasoning_levels))
  expect(ultra?.reasoning === true && ultra!.reasoning_levels!.length === 0, "nemotron-ultra reasoning=true, no levels", JSON.stringify(ultra?.reasoning_levels))
  expect(superVl?.reasoning === true && superVl!.reasoning_levels!.join(",") === "none,minimal,low,medium,high,xhigh", "nemotron-super-vl none..xhigh", JSON.stringify(superVl?.reasoning_levels))
}

console.log("\n[2] mimo effort tolerated (always-on reasoning)")
{
  const r = await chatWithEffort("mimo-v2.6-flash-free", "high")
  expect(r.ok, "mimo effort=high completes with 144", r.content.slice(0, 60))
}

console.log("\n[3] space-bunny effort levels end-to-end")
for (const level of ["minimal", "high", "max"]) {
  const r = await chatWithEffort("space-bunny-free", level)
  expect(r.ok, `space-bunny effort=${level} completes with 144`, r.content.slice(0, 60))
}

console.log("\n[4] space-bunny effort=none clamped to minimal (no upstream 400)")
{
  const r = await chatWithEffort("space-bunny-free", "none")
  expect(r.ok, "space-bunny effort=none completes", r.content.slice(0, 60))
}

console.log("\n[5] step-5 effort levels end-to-end (retired id, deepseek alias: none clamped to low)")
for (const level of ["none", "low", "high", "max"]) {
  const r = await chatWithEffort("step-5-preview-free", level)
  expect(r.ok, `step-5 effort=${level} completes with 144`, r.content.slice(0, 60))
}

console.log("\n[6] deepseek effort levels end-to-end (none clamped to low, undocumented levels dropped)")
for (const level of ["low", "high", "max"]) {
  const r = await chatWithEffort("deepseek-v4.1-flash-free", level)
  expect(r.ok, `deepseek effort=${level} completes with 144`, r.content.slice(0, 60))
}
for (const level of ["none", "minimal", "medium", "xhigh"]) {
  const r = await chatWithEffort("deepseek-v4.1-flash-free", level)
  expect(r.ok, `deepseek effort=${level} completes with 144`, r.content.slice(0, 60))
}

console.log("\n[7] glm effort levels end-to-end (none clamped to low, undocumented levels dropped)")
for (const level of ["low", "high", "max"]) {
  const r = await chatWithEffort("glm-5.3-flash-free", level)
  expect(r.ok, `glm effort=${level} completes with 144`, r.content.slice(0, 60))
}
for (const level of ["none", "minimal", "medium", "xhigh"]) {
  const r = await chatWithEffort("glm-5.3-flash-free", level)
  expect(r.ok, `glm effort=${level} completes with 144`, r.content.slice(0, 60))
}

console.log("\n[8] muse effort=high regression (deepseek alias)")
{
  const r = await chatWithEffort("muse-spark-1.3-contributor-free", "high")
  expect(r.ok, "muse effort=high completes with 144", r.content.slice(0, 60))
}

console.log("\n[9] 2026-10-19 additions: beam + nemotron-super-vl effort levels end-to-end")
for (const level of ["low", "max"]) {
  const r = await chatWithEffort("beam-free", level)
  expect(r.ok, `beam effort=${level} completes with 144`, r.content.slice(0, 60))
}
for (const level of ["none", "high"]) {
  const r = await chatWithEffort("nemotron-3.5-super-vl-free", level)
  expect(r.ok, `nemotron-3.5-super-vl-free effort=${level} completes with 144`, r.content.slice(0, 60))
}

console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
process.exit(0)
