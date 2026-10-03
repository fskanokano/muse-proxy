// Local runner for the `v1` Supabase Edge Function.
//
// `supabase functions serve` needs a Docker daemon; this script runs the exact
// same router (supabase/functions/v1/router.ts) on a plain Deno HTTP server so
// the deployed code path can be exercised over real HTTP in any environment:
// streaming SSE, client aborts and the opencode zen upstream all behave the way
// they do on the edge runtime.
//
//   bun run serve:edge            # PORT (default 8788), bind 0.0.0.0
//
// The deployed entrypoint (supabase/functions/v1/index.ts) is identical apart
// from taking its port from the platform instead of the environment.

import { handleRequest, type ProxyEnv } from "../supabase/functions/v1/router.ts"

const port = Number(Deno.env.get("PORT") ?? "8788")
const hostname = Deno.env.get("HOST") ?? "0.0.0.0"

function envFromRuntime(): ProxyEnv {
  return { PROXY_API_KEY: Deno.env.get("PROXY_API_KEY") ?? undefined }
}

Deno.serve({ port, hostname, onListen: ({ hostname, port }) => {
  console.log(`muse-proxy edge function listening on http://${hostname}:${port}`)
  console.log(`  POST /functions/v1/v1/chat/completions`)
  console.log(`  POST /functions/v1/v1/responses`)
  console.log(`  POST /functions/v1/v1/messages`)
  console.log(`  GET  /functions/v1/v1/models`)
  if (!Deno.env.get("PROXY_API_KEY")) {
    console.warn("warning: PROXY_API_KEY is unset — every request will fail closed with 401")
  }
} }, (request: Request) => handleRequest(request, envFromRuntime()))