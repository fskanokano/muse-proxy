// Vercel shell for POST /v1/responses (see vercel.json's
// `/v1/responses -> /api/responses` rewrite).
//
// The implementation now lives in the Supabase Edge Function
// (`supabase/functions/v1/responses.ts`), which is the deployment target. This
// file only adds the two things the Vercel Node runtime needs and Deno does not
// have: `process.env` and the `export default { fetch }` entry contract.

import { handleResponsesRequest } from "../supabase/functions/v1/responses.ts"

export * from "../supabase/functions/v1/responses.ts"

async function handler(request: Request): Promise<Response> {
  return handleResponsesRequest(request, { PROXY_API_KEY: process.env.PROXY_API_KEY })
}

export default { fetch: handler }
export { handler as POST, handler as GET }