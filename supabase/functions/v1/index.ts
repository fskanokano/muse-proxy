// Edge Function entrypoint for muse-proxy.
//
// Mounted at `/functions/v1/v1`, so the deployed base URL keeps the OpenAI /
// Anthropic paths intact (see router.ts). Deploy with:
//
//   supabase link --project-ref <project-ref>
//   supabase secrets set PROXY_API_KEY=<key>
//   supabase functions deploy v1 --no-verify-jwt
//
// Authentication: the proxy's own fail-closed PROXY_API_KEY check lives in
// _lib/auth.ts (`Authorization: Bearer <key>` or `x-api-key: <key>`), so the
// gateway's JWT verification is disabled for this function (see
// supabase/config.toml). This is the same shape as Supabase's documented
// "external webhook" pattern: verify_jwt = false plus a handler that
// authenticates the caller itself. Consequence: clients need NO Supabase
// `apikey` header — `Authorization: Bearer $PROXY_API_KEY` alone is enough,
// so the proxy stays a drop-in OpenAI/Anthropic base URL.

import { handleRequest, type ProxyEnv } from "./router.ts"

// `Deno.env.get` needs --allow-env, which the Supabase edge runtime grants by
// default (as does --allow-net for the upstream fetch).
function envFromRuntime(): ProxyEnv {
  return { PROXY_API_KEY: Deno.env.get("PROXY_API_KEY") ?? undefined }
}

Deno.serve((request: Request) => handleRequest(request, envFromRuntime()))