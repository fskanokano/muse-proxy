// Local stand-in for the Supabase platform — bundles the edge function the way
// `supabase functions deploy` does and serves the resulting artifact behind an
// emulated Kong gateway, so the DEPLOYED shape can be exercised without a
// Supabase account or Docker.
//
//   bun run serve:fake            # gateway on $PORT (default 8788)
//
// What this reproduces, and why it is worth it:
//
//   1. `bun run bundle:function` runs `deno bundle` over
//      supabase/functions/v1/index.ts -> supabase/.temp/v1-bundle.js — one
//      self-contained file, exactly the artifact the CLI uploads. Previous
//      testing ran the TypeScript source tree, which cannot catch
//      bundling-only breakage (a stray dynamic import, a file outside the
//      function dir, a non-bundleable dependency).
//   2. The bundle is imported and runs under Deno exactly as the edge runtime
//      would (Deno.serve on 0.0.0.0:8000, secrets via --allow-env).
//   3. A gateway in front of it reproduces the platform behaviour the function
//      cannot see from inside: `/functions/v1/<slug>[/...]` routing with the
//      FULL original path forwarded, the real "Requested function was not
//      found" 404 for an unknown slug, and the `verify_jwt` gate read from the
//      real supabase/config.toml (so a config typo fails here too).
//
// What it does NOT reproduce: the real Kong/edge-runtime deployment, region
// routing, and the platform's CPU/memory/wall-clock quotas. Those need a real
// project; this covers everything the function and its config own.

const REPO_ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "")
const FUNCTION_DIR = `${REPO_ROOT}/supabase/functions`
const CONFIG = `${REPO_ROOT}/supabase/config.toml`
const FUNCTION_NAME = "v1"
// The bundle calls `Deno.serve(handler)` with no options, so it always binds
// this port. Override only if something else already owns it.
const FUNCTION_PORT = Number(Deno.env.get("FAKE_SUPABASE_FUNCTION_PORT") ?? "8000")
const GATEWAY_PORT = Number(Deno.env.get("PORT") ?? "8788")
const GATEWAY_HOST = Deno.env.get("HOST") ?? "0.0.0.0"

/** Deployed function name -> whether the platform checks JWTs for it. */
async function loadDeployedFunctions(): Promise<Map<string, boolean>> {
  const toml = await Deno.readTextFile(CONFIG)
  const deployed = new Map<string, boolean>()
  let current: string | null = null
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim()
    if (line.startsWith("[") && line.endsWith("]")) {
      const section = line.slice(1, -1)
      const match = /^functions\.(.+)$/.exec(section)
      current = match ? match[1] : null
      // A [functions.<name>] block with no verify_jwt key means the platform
      // default: JWT verification ON.
      if (current !== null) deployed.set(current, true)
      continue
    }
    if (current === null) continue
    const verify = /^verify_jwt\s*=\s*(true|false)/.exec(line)
    if (verify) deployed.set(current, verify[1] === "true")
  }
  return deployed
}

/** The deploy step is a separate script (`bun run bundle:function`) so this
 * process never shells out — bundling and serving stay two distinct phases,
 * mirroring `supabase functions deploy` then `serve`. */
function artifactPath(): string {
  return `${REPO_ROOT}/supabase/.temp/${FUNCTION_NAME}-bundle.js`
}

function gatewayJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/** `/functions/v1/<slug>` or `/functions/v1/<slug>/<rest>` -> slug, or null. */
function parseRoute(pathname: string): { slug: string } | null {
  const match = /^\/functions\/v1\/([^/]+)(?:\/.*)?$/.exec(pathname)
  return match ? { slug: match[1]! } : null
}

async function main(): Promise<void> {
  const deployed = await loadDeployedFunctions()
  const artifact = artifactPath()
  let size = 0
  try {
    size = (await Deno.stat(artifact)).size
  } catch {
    throw new Error(`missing ${artifact} — run \`bun run bundle:function\` first`)
  }
  console.log(`[fake-supabase] bundled ${FUNCTION_NAME} -> supabase/.temp/${FUNCTION_NAME}-bundle.js (${size} bytes)`)
  console.log(`[fake-supabase] config.toml: ${[...deployed].map(([name, jwt]) => `${name} verify_jwt=${jwt}`).join(", ")}`)

  // Importing the artifact runs its own Deno.serve(), exactly like the edge
  // runtime loading a deployed bundle.
  await import(`file://${artifact}`)
  console.log(`[fake-supabase] function artifact listening on 0.0.0.0:${FUNCTION_PORT}`)

  Deno.serve({ port: GATEWAY_PORT, hostname: GATEWAY_HOST }, async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const route = parseRoute(url.pathname)
    if (route === null) {
      return gatewayJson(404, { message: "Requested function was not found" }, { "sb-error-code": "NOT_FOUND" })
    }
    if (!deployed.has(route.slug)) {
      return gatewayJson(404, { message: "Requested function was not found" }, { "sb-error-code": "NOT_FOUND" })
    }
    // Platform JWT gate. verify_jwt = false (our config) skips it entirely,
    // which is why clients need no Supabase apikey header.
    if (deployed.get(route.slug) === true) {
      const authorization = request.headers.get("authorization")
      const apikey = request.headers.get("apikey")
      if (!authorization && !apikey) {
        return gatewayJson(
          401,
          { message: "Missing authorization header" },
          { "sb-error-code": "UNAUTHORIZED_NO_AUTH_HEADER" },
        )
      }
    }

    // Forward the FULL original path: the platform does not strip the mount
    // point, which is the assumption the function's router has to tolerate.
    const upstream = await fetch(`http://127.0.0.1:${FUNCTION_PORT}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      // Client disconnects must reach the function so it can stop billing the
      // upstream — same as the real gateway.
      signal: request.signal,
      // @ts-expect-error Deno requires duplex for streaming request bodies.
      duplex: "half",
    })
    return upstream
  })

  console.log(`[fake-supabase] gateway listening on http://${GATEWAY_HOST}:${GATEWAY_PORT}`)
  console.log(`[fake-supabase] try: curl -H "Authorization: Bearer $PROXY_API_KEY" http://127.0.0.1:${GATEWAY_PORT}/functions/v1/v1/models`)
  if (!Deno.env.get("PROXY_API_KEY")) {
    console.warn("[fake-supabase] warning: PROXY_API_KEY is unset — every request fails closed with 401")
  }
}

await main()