import { describe, expect, it } from "vitest"
import { identityForCall, partId, projectIdFrom } from "../supabase/functions/muse-proxy/_lib/identity.ts"

describe("identityForCall", () => {
  it("produces opencode-shaped session and message ids", () => {
    const { sessionId, requestId } = identityForCall("chatcmpl-1", 1_758_000_000_000)
    expect(sessionId).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(requestId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(sessionId).toHaveLength(4 + 26)
    expect(requestId).toHaveLength(4 + 26)
  })

  it("encodes the complemented timestamp into the low 48 bits, like Identifier.create(true)", () => {
    const at = 1_758_000_000_000
    const { requestId } = identityForCall("a", at)
    const encoded = BigInt("0x" + requestId.slice(4, 16))
    // SessionID.create() uses the descending variant, so the stored 48 bits are
    // the complement of (ms<<12 | counter). Undo both to recover the ms.
    const counter = ~encoded & 0xfffn
    const recoveredMs = ((~encoded & ((1n << 48n) - 1n)) - counter) / 0x1000n
    // opencode keeps (ms<<12|counter) in 48 bits; at the current epoch the top
    // bits are shifted out, so only ms % 2^36 survives.
    expect(recoveredMs).toBe(BigInt(at) % (1n << 36n))
  })

  it("keeps every id's low 12 bits inside the free-tier gate window (>= 0xFC0)", () => {
    // Probed 2026-10-13 by replaying a captured real CLI request: the zen gate
    // re-derives the descending per-millisecond counter from the id and rejects
    // the request with 403 FreeTierError unless the low 12 bits are >= 0xFC0
    // (counter 63 passes, 64 fails; the timestamp prefix is irrelevant). Sweep
    // seeds/timestamps so a regression in the counter derivation cannot slip
    // through on a single lucky id.
    for (let i = 0; i < 300; i++) {
      const at = 1_758_000_000_000 + i * 7919
      const { sessionId, requestId } = identityForCall(`seed-${i}`, at)
      const ids = [sessionId, requestId, partId(`seed-${i}`, "user", i % 4, at)]
      for (const id of ids) {
        const low12 = Number(BigInt("0x" + id.slice(4, 16)) & 0xfffn)
        expect(low12).toBeGreaterThanOrEqual(0xfc0)
        // ... which is exactly a small per-millisecond counter.
        expect(~BigInt("0x" + id.slice(4, 16)) & 0xfffn).toBeLessThanOrEqual(0x3fn)
      }
    }
  })

  it("is deterministic per call id and varies across call ids", () => {
    const a = identityForCall("chatcmpl-x", 1_758_000_000_000)
    const a2 = identityForCall("chatcmpl-x", 1_758_000_000_000)
    const b = identityForCall("chatcmpl-y", 1_758_000_000_000)
    expect(a.requestId).toBe(a2.requestId)
    expect(a.requestId).not.toBe(b.requestId)
    expect(a.sessionId).not.toBe(b.sessionId)
  })

  it("ids stay identical within the same millisecond but differ across milliseconds", () => {
    const t1 = identityForCall("chatcmpl-a", 1_758_000_000_000)
    const t2 = identityForCall("chatcmpl-a", 1_758_000_000_500)
    // different ms -> different time component
    expect(t1.requestId).not.toBe(t2.requestId)
  })

  it("derives the session from the request seed so retries keep the suffix", () => {
    // Same call id, same ms => identical identity (retry of a completion).
    const first = identityForCall("chatcmpl-retry", 1_758_000_000_000)
    const retried = identityForCall("chatcmpl-retry", 1_758_000_000_000)
    expect(first.requestId).toBe(retried.requestId)
    expect(first.sessionId).toBe(retried.sessionId)
  })
})

describe("partId", () => {
  it("produces opencode-shaped part ids distinct per role/index", () => {
    const a = partId("call", "user", 0, 1_758_000_000_000)
    const b = partId("call", "user", 1, 1_758_000_000_000)
    const c = partId("call", "assistant", 0, 1_758_000_000_000)
    expect(a).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe("projectIdFrom", () => {
  it("is stable per call and opaque", () => {
    expect(projectIdFrom("chatcmpl-1")).toBe(projectIdFrom("chatcmpl-1"))
    expect(projectIdFrom("chatcmpl-1")).not.toBe(projectIdFrom("chatcmpl-2"))
  })
})
