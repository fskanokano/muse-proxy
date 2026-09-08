// GET /v1/models (rewritten to /api/models) — static catalog of the free
// muse model, OpenAI models-list format.

import { checkAuth } from "./_lib/auth"
import { jsonError } from "./_lib/errors"
import { MODEL_ID, MODEL_NAME } from "./_lib/types"

export interface ModelsEnv {
  PROXY_API_KEY?: string
}

export function modelsList(created: number) {
  return {
    object: "list",
    data: [
      {
        id: MODEL_ID,
        object: "model",
        created,
        owned_by: "opencode-zen",
        name: MODEL_NAME,
        description:
          "Muse Spark 1.3 Contributor (free tier) served via opencode zen with encrypted-reasoning replay. Any model id requested maps here.",
        context_window: 1_048_576,
        max_output_tokens: 32_000,
      },
    ],
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

export default async function handler(request: Request): Promise<Response> {
  return handleModelsRequest(request, { PROXY_API_KEY: process.env.PROXY_API_KEY })
}
