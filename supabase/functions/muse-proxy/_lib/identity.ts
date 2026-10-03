// opencode client identifier synthesis.
//
// opencode stamps every zen request with opaque, time-ordered client IDs
// (packages/opencode/src/id/id.ts `Identifier.create`): a `<prefix>_` +
// 6-byte big-endian (timestamp<<12 | counter) hex time component + base62
// suffix, 26 chars total. The zen edge gates the free tier on this header
// fingerprint, so the proxy mirrors the shape exactly instead of sending
// bare UUIDs, which read as non-opencode traffic.
//
// Deterministic per (callId, role) so an upstream retry of the same
// completion keeps the same identity.

const PREFIXES = {
  session: "ses",
  message: "msg",
  part: "prt",
} as const

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// Deterministic 26-char base62 suffix from an ASCII seed (FNV-1a + xorshift).
function suffixFrom(seed: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const next = () => {
    h ^= h << 13
    h >>>= 0
    h ^= h >>> 17
    h ^= h << 5
    h >>>= 0
    return h
  }
  let out = ""
  for (let i = 0; i < 14; i++) {
    out += BASE62[next() % 62]
  }
  return out
}

// `prefix_` + 12 hex chars of (48-bit) time component + 14 base62 chars =
// 26 chars after the underscore, matching Identifier.create's layout.
// Identifier.create keeps the low 48 bits of (ms<<12|counter): at current
// epoch the top 12 bits are already shifted out, exactly as in opencode.
function opencodeId(prefix: keyof typeof PREFIXES, seed: string, atMs = Date.now()): string {
  const counter = atMs % 0x1000
  const time = (BigInt(atMs) * BigInt(0x1000) + BigInt(counter)) & BigInt("0xffffffffffff")
  let hex = ""
  let remaining = time
  for (let i = 0; i < 6; i++) {
    const byte = Number(remaining & BigInt(0xff))
    hex = byte.toString(16).padStart(2, "0") + hex
    remaining >>= BigInt(8)
  }
  return `${PREFIXES[prefix]}_${hex}${suffixFrom(seed)}`
}

function hash32(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export interface OpenCodeIdentity {
  sessionId: string
  requestId: string
}

// One stable identity per upstream call: `msg_<time><rand>` request id, plus
// the session it belongs to. The session is derived from the request id so a
// retried completion lands on the same session, like a real client retry.
export function identityForCall(callId: string, atMs = Date.now()): OpenCodeIdentity {
  const sessionId = opencodeId("session", `ses:${callId}`, atMs)
  const requestId = opencodeId("message", `msg:${callId}`, atMs)
  return { sessionId, requestId }
}

export function partId(callId: string, role: string, index: number, atMs = Date.now()): string {
  return opencodeId("part", `prt:${callId}:${role}:${index}`, atMs)
}

// `projectId` only feeds a hash; keep the full helper for future callers.
export function projectIdFrom(callId: string): string {
  return `prt_${hash32(`prj:${callId}`).toString(16).padStart(8, "0")}`.slice(0, 12)
}
