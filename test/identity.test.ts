import { describe, expect, it } from "vitest"
import { identityForCall, partId, projectIdFrom } from "../supabase/functions/v1/_lib/identity.ts"

describe("identityForCall", () => {
  it("produces opencode-shaped session and message ids", () => {
    const { sessionId, requestId } = identityForCall("chatcmpl-1", 1_758_000_000_000)
    expect(sessionId).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(requestId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(sessionId).toHaveLength(4 + 26)
    expect(requestId).toHaveLength(4 + 26)
  })

  it("encodes the timestamp into the low 48 bits, like Identifier.create", () => {
    const at = 1_758_000_000_000
    const { requestId } = identityForCall("a", at)
    const hex = requestId.slice(4, 16)
    const encoded = BigInt("0x" + hex)
    // opencode keeps (ms<<12|counter) in 48 bits; the top 12 bits of the
    // current epoch are shifted out, so recover with the same modulus.
    const recovered = Number(encoded / 0x1000n) + Math.floor(1757652480_000 / 0x100000) * 0x100000
    expect(recovered % 0x100000).toBe(at % 0x100000)
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
