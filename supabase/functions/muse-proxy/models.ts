// GET /v1/models (Supabase Edge Function `muse-proxy`) — catalog of the free models
// the proxy serves, OpenAI models-list format. muse-spark keeps its historical
// "any model id maps here" note; the two new free models route to the
// oa-compat upstream (see _lib/types.ts MODELS).
//
// reasoning advertises whether the model thinks at all (mimo's reasoning is
// always on even though it exposes no effort levels); reasoning_levels
// advertises the reasoning_effort values each model accepts (empty array = no
// effort control), so clients can drive the facade-specific fields
// (reasoning_effort / reasoning.effort / thinking.budget_tokens) from one place.
// The capability map mirrors the models.opencode.ai catalog flags.

import { checkAuth } from "./_lib/auth.ts"
import { jsonError } from "./_lib/errors.ts"
import { MODELS } from "./_lib/types.ts"

export interface ModelsEnv {
  PROXY_API_KEY?: string
}

// Reasoning-capable models (mirrors the models.opencode.ai catalog: every
// muse/zen free model here reasons; mimo just has no effort levels).
const REASONING_MODELS = new Set(["muse-spark-1.3-contributor-free", "mimo-v2.6-flash-free", "space-bunny-free"])

export function modelsList(created: number) {
  return {
    object: "list",
    data: Object.values(MODELS).map((model) => ({
      id: model.id,
      object: "model",
      created,
      owned_by: "opencode-zen",
      name: model.name,
      description: model.description,
      context_window: model.contextWindow,
      max_output_tokens: model.maxOutputTokens,
      reasoning: REASONING_MODELS.has(model.id),
      reasoning_levels: [...model.efforts],
    })),
  }
}

export function handleModelsRequest(request: Request, env: ModelsEnv): Response {
  if (!checkAuth(request, env)) {
    const error = jsonError(401, "invalid or missing proxy API key", "invalid_proxy_key", "authentication_error")
    return new Response(JSON.stringify(error.body), {
      status: error.status,
      headers: { "content-type": "application/json" },
    })
  }
  return new Response(JSON.stringify(modelsList(Math.floor(Date.now() / 1000))), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}