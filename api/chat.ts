// Vercel shell for POST /v1/chat/completions (see vercel.json's
// `/v1/chat/completions -> /api/chat` rewrite).
//
// The implementation now lives in the Supabase Edge Function
// (`supabase/functions/v1/chat.ts`), which is the deployment target. This file
// only adds the two things the Vercel Node runtime needs and Deno does not
// have: `process.env` and the `export default { fetch }` entry contract. One
// implementation, two hosts — do not fork the pipeline here.

import { handleChatRequest } from "../supabase/functions/v1/chat.ts"

export * from "../supabase/functions/v1/chat.ts"

async function handler(request: Request): Promise<Response> {
  return handleChatRequest(request, { PROXY_API_KEY: process.env.PROXY_API_KEY })
}

export default { fetch: handler }
export { handler as POST, handler as GET }