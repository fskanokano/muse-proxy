// Vercel shell for GET /v1/models (see vercel.json's
// `/v1/models -> /api/models` rewrite).
//
// The implementation now lives in the Supabase Edge Function
// (`supabase/functions/v1/models.ts`), which is the deployment target. This
// file only adds `process.env` and the `export default { fetch }` entry
// contract that the Vercel Node runtime expects.

import { handleModelsRequest } from "../supabase/functions/v1/models.ts"

export * from "../supabase/functions/v1/models.ts"

async function handler(request: Request): Promise<Response> {
  return handleModelsRequest(request, { PROXY_API_KEY: process.env.PROXY_API_KEY })
}

export default { fetch: handler }
export { handler as POST, handler as GET }