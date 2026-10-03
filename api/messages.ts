// Vercel shell for POST /v1/messages (see vercel.json's
// `/v1/messages -> /api/messages` rewrite).
//
// The implementation now lives in the Supabase Edge Function
// (`supabase/functions/muse-proxy/messages.ts`), which is the deployment target. This
// file only adds the two things the Vercel Node runtime needs and Deno does not
// have: `process.env` and the `export default { fetch }` entry contract.

import { handleMessagesRequest } from "../supabase/functions/muse-proxy/messages.ts"

export * from "../supabase/functions/muse-proxy/messages.ts"

async function handler(request: Request): Promise<Response> {
  return handleMessagesRequest(request, { PROXY_API_KEY: process.env.PROXY_API_KEY })
}

export default { fetch: handler }
export { handler as POST, handler as GET }