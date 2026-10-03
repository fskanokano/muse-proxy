// Proxy auth: accepts `Authorization: Bearer <key>` or `x-api-key: <key>`,
// compared against the PROXY_API_KEY env var in constant time. Upstream
// (opencode zen) auth is unrelated and always uses the literal "public" key
// for the free muse-spark model.

function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

export function checkAuth(request: Request, env: { PROXY_API_KEY?: string }): boolean {
  const key = env.PROXY_API_KEY
  if (!key) return false
  const header = request.headers.get("authorization")
  const bearer = header !== null && header.startsWith("Bearer ") ? header.slice(7) : undefined
  const xKey = request.headers.get("x-api-key") ?? undefined
  const provided = bearer ?? xKey
  if (provided === undefined || provided.length === 0) return false
  return timingSafeEqual(provided, key)
}
