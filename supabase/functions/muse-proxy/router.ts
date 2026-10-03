// Path router for the `muse-proxy` Supabase Edge Function.
//
// The function is mounted at `/functions/v1/muse-proxy`, so the deployed URLs are
// exactly the OpenAI / Anthropic paths:
//
//   POST https://<ref>.supabase.co/functions/v1/muse-proxy/v1/chat/completions
//   POST https://<ref>.supabase.co/functions/v1/muse-proxy/v1/responses
//   POST https://<ref>.supabase.co/functions/v1/muse-proxy/v1/messages
//   GET  https://<ref>.supabase.co/functions/v1/muse-proxy/v1/models
//
// i.e. OpenAI SDKs point `base_url` at `https://<ref>.supabase.co/functions/v1/muse-proxy/v1`
// and Anthropic SDKs at `https://<ref>.supabase.co/functions/v1` — no per-client
// URL rewriting needed. One function, four routes: it boots once and keeps the
// instance warm across endpoints (the alternative, one function per endpoint,
// pays a cold start per facade).
//
// This module is deliberately free of Deno globals so it stays unit-testable
// under vitest and reusable by the Vercel compatibility shells in `api/`.

import { handleChatRequest, type ChatDependencies } from "./chat.ts"
import { handleMessagesRequest, type MessagesDependencies } from "./messages.ts"
import { handleModelsRequest } from "./models.ts"
import { handleResponsesRequest, type ResponsesDependencies } from "./responses.ts"

/** Environment contract shared by every facade (fail-closed on absence). */
export interface ProxyEnv {
  PROXY_API_KEY?: string
}

/** Test seam: inject a stub `fetch` to avoid touching the real upstream. */
export interface ProxyDependencies {
  fetchImpl?: typeof fetch
}

type Route = "chat" | "responses" | "messages" | "models"

/**
 * Prefixes the gateway (or `supabase functions serve`) may prepend before the
 * function's own sub-path. The first match wins, longest first, so
 * `/functions/v1/muse-proxy/chat/completions` is not mistaken for the function's
 * `/functions/v1` mount plus a `v1/chat/completions` route.
 *
 * `/muse-proxy/...` is the OpenAI-compatible sub-path INSIDE the function
 * (keeps the old `/v1/...` client URL shape working after the function was
 * renamed from `v1` to `muse-proxy`): the full gateway path is
 * `/functions/v1/muse-proxy/v1/chat/completions`, and after stripping the
 * `/functions/v1/muse-proxy` mount the remainder is `/v1/chat/completions`,
 * which still needs one more strip before matching ROUTES.
 */
const MOUNT_PREFIXES = ["/functions/v1/muse-proxy", "/functions/v1", "/muse-proxy", "/v1"]

const ROUTES: Record<string, Route> = {
  "/chat/completions": "chat",
  "/responses": "responses",
  "/messages": "messages",
  "/models": "models",
}

// Strip the mount point and any trailing slash so one matcher serves both the
// hosted gateway and a bare `/functions/v1/<name>` local serve. Stripping
// repeats: the full gateway path is `/functions/v1/muse-proxy/v1/models` —
// first the gateway mount goes, then the in-function `/v1` API prefix.
export function normalizePath(pathname: string): string {
  let path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  for (let i = 0; i < 2; i++) {
    let stripped = false
    for (const prefix of MOUNT_PREFIXES) {
      if (path === prefix) return "/"
      if (path.startsWith(`${prefix}/`)) {
        path = path.slice(prefix.length)
        stripped = true
        break
      }
    }
    if (!stripped) break
  }
  return path === "" ? "/" : path
}

export function matchRoute(pathname: string): Route | null {
  return ROUTES[normalizePath(pathname)] ?? null
}

function notFound(path: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `unknown route ${path}; available: /v1/chat/completions, /v1/responses, /v1/messages, /v1/models`,
        type: "invalid_request_error",
        code: "not_found",
        param: null,
      },
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  )
}

function rootIndex(path: string): Response {
  return new Response(
    JSON.stringify({
      service: "muse-proxy",
      runtime: "supabase-edge-functions",
      function: "muse-proxy",
      mount: "/functions/v1/muse-proxy",
      endpoints: ["POST /v1/chat/completions", "POST /v1/responses", "POST /v1/messages", "GET /v1/models"],
      auth: "send `Authorization: Bearer $PROXY_API_KEY` (or `x-api-key`) — the gateway JWT check is off (verify_jwt=false), so no Supabase apikey is needed",
      requested_path: path,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

/**
 * Single entry point for every facade. `env` is injected rather than read from
 * `Deno.env` here so the same function is reusable from Node (Vercel shells,
 * tests) unchanged.
 */
export async function handleRequest(
  request: Request,
  env: ProxyEnv,
  dependencies: ProxyDependencies = {},
): Promise<Response> {
  const path = new URL(request.url).pathname
  const route = matchRoute(path)
  if (route === null) {
    if (normalizePath(path) === "/") return rootIndex(path)
    return notFound(path)
  }
  switch (route) {
    case "chat":
      return handleChatRequest(request, env, dependencies as ChatDependencies)
    case "responses":
      return handleResponsesRequest(request, env, dependencies as ResponsesDependencies)
    case "messages":
      return handleMessagesRequest(request, env, dependencies as MessagesDependencies)
    case "models":
      return handleModelsRequest(request, env)
  }
}