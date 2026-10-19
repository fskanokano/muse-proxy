// GET /v1/models (Supabase Edge Function `muse-proxy`) — catalog of the free models
// the proxy serves, OpenAI models-list format. muse-spark keeps its historical
// "any model id maps here" note; every listed entry routes to the oa-compat
// upstream (muse / step-5 / goal are upstream-retired ids that alias a live
// model and are NOT listed — see _lib/types.ts MODELS + `listed`).
//
// reasoning advertises whether the model thinks at all (mimo's reasoning is
// always on even though it exposes no effort levels); reasoning_levels
// advertises the reasoning_effort values each model accepts (empty array = no
// effort control), so clients can drive the facade-specific fields
// (reasoning_effort / reasoning.effort / thinking.budget_tokens) from one place.
// The capability map mirrors the models.opencode.ai catalog flags.

import { checkAuth } from "./_lib/auth.js"
import { jsonError } from "./_lib/errors.js"
import { MODELS } from "./_lib/types.js"

export interface ModelsEnv {
  PROXY_API_KEY?: string
}

// Reasoning-capable models (mirrors the models.opencode.ai catalog: every zen
// free entry reasons; mimo / longcat / nemotron lightning+ultra / big-pickle
// just have no effort levels). The muse / step-5 entries are upstream-retired
// aliases served by deepseek-v4.1-flash-free, so they follow its metadata.
const REASONING_MODELS = new Set([
  "muse-spark-1.3-contributor-free",
  "mimo-v2.6-flash-free",
  "space-bunny-free",
  "step-5-preview-free",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "big-pickle",
  "longcat-2.5-preview-free",
  "beam-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-super-vl-free",
  "muse-spark-1.3-contributor-goal",
])

export function modelsList(created: number) {
  return {
    object: "list",
    // 退役模型 (listed:false) 不上架:它们的 id 仍在 MODELS 里供 resolveModel
    // 解析 (upstreamId 别名到存活模型),只是不出现在 /v1/models 目录中。
    data: Object.values(MODELS)
      .filter((model) => model.listed !== false)
      .map((model) => ({
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
async function handler(request: Request): Promise<Response> {
  return handleModelsRequest(request, { PROXY_API_KEY: process.env.PROXY_API_KEY })
}

export default { fetch: handler }
export { handler as POST, handler as GET }
