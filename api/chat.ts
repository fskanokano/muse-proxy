// POST /v1/chat/completions (rewritten to /api/chat) — the main facade.
//
// Pipeline: auth -> lower (chat -> Responses) -> fetch opencode zen -> raise
// (Responses SSE -> chat chunks) -> SSE out (or aggregated JSON for
// stream:false).

import { checkAuth } from "./_lib/auth.js"
import { errorChunk, jsonError, upstreamErrorToOpenAI } from "./_lib/errors.js"
import { lowerRequest } from "./_lib/lower.js"
import { createRaiser } from "./_lib/raise.js"
import { chunkToSse, DONE_LINE, HEARTBEAT_COMMENT, HEARTBEAT_INTERVAL_MS, parseUpstreamSse } from "./_lib/sse.js"
import type { ChatToolCall, ChatUsage, UpstreamEvent } from "./_lib/types.js"
import { usageToChat } from "./_lib/usage.js"
import { MODEL_ID, MODEL_NAME, UPSTREAM_API_KEY, UPSTREAM_URL } from "./_lib/types.js"

export interface ChatEnv {
  PROXY_API_KEY?: string
}

export interface ChatDependencies {
  fetchImpl?: typeof fetch
}

type FetchFn = typeof fetch

function jsonResponse(res: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(res.body), {
    status: res.status,
    headers: { "content-type": "application/json" },
  })
}

// Aggregate streamed chunks into a non-streaming chat.completion object.
class CompletionBuilder {
  content = ""
  reasoning = ""
  toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = []
  finishReason: string | null = null
  usage: ChatUsage | undefined

  addEvent(event: UpstreamEvent) {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      this.content += event.delta
      return
    }
    if (
      (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") &&
      typeof event.delta === "string"
    ) {
      this.reasoning += event.delta
      return
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const callId = event.item.call_id ?? event.item.id
      if (callId && event.item.name) {
        this.toolCalls.push({
          id: callId,
          type: "function",
          function: { name: event.item.name, arguments: event.item.arguments ?? "" },
        })
      }
      return
    }
    if (event.type === "response.completed") {
      this.finishReason = this.toolCalls.length > 0 ? "tool_calls" : "stop"
      this.usage = usageToChat(event.response?.usage)
      return
    }
    if (event.type === "response.incomplete") {
      this.finishReason = "length"
      this.usage = usageToChat(event.response?.usage)
      return
    }
    if (event.type === "error" || event.type === "response.failed") {
      const code = event.code ?? event.response?.error?.code ?? undefined
      const message = event.message ?? event.response?.error?.message ?? "unknown upstream error"
      this.content += `[muse-proxy upstream error] ${code ? `${code}: ` : ""}${message}`
      this.finishReason = "stop"
    }
  }

  build(id: string, created: number): Record<string, unknown> {
    const message: Record<string, unknown> = { role: "assistant", content: this.content }
    if (this.reasoning.length > 0) message.reasoning_content = this.reasoning
    if (this.toolCalls.length > 0) message.tool_calls = this.toolCalls
    const body: Record<string, unknown> = {
      id,
      object: "chat.completion",
      created,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          message,
          finish_reason: this.finishReason ?? "stop",
        },
      ],
    }
    if (this.usage) body.usage = this.usage
    return body
  }
}

export async function handleChatRequest(
  request: Request,
  env: ChatEnv,
  dependencies: ChatDependencies = {},
): Promise<Response> {
  const fetchImpl: FetchFn = dependencies.fetchImpl ?? fetch

  if (!checkAuth(request, env)) {
    return jsonResponse(jsonError(401, "invalid or missing proxy API key", "invalid_proxy_key", "authentication_error"))
  }
  if (request.method !== "POST") {
    return jsonResponse(jsonError(405, "method not allowed", "method_not_allowed"))
  }

  let chatBody: unknown
  try {
    chatBody = await request.json()
  } catch {
    return jsonResponse(jsonError(400, "request body must be valid JSON"))
  }

  const lowered = lowerRequest(chatBody)
  if ("error" in lowered) {
    return jsonResponse(jsonError(lowered.error.status, lowered.error.message, lowered.error.code))
  }

  const chat = chatBody as { stream?: boolean }
  const wantsStream = chat.stream === true

  const completionId = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  let upstream: Response
  try {
    upstream = await fetchImpl(UPSTREAM_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${UPSTREAM_API_KEY}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(lowered.request),
      // Propagate client disconnects so we stop billing upstream tokens.
      signal: request.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "network error"
    return jsonResponse(jsonError(502, `failed to reach opencode zen: ${message}`, "upstream_unreachable", "api_error"))
  }

  if (!upstream.ok || upstream.body === null) {
    let upstreamJson: unknown = null
    try {
      upstreamJson = await upstream.json()
    } catch {
      upstreamJson = null
    }
    return jsonResponse(upstreamErrorToOpenAI(upstream.status, upstreamJson))
  }

  const events: AsyncGenerator<Record<string, unknown> | "done"> = parseUpstreamSse(upstream.body)

  // ------------------------------------------------------------------
  // Non-streaming: aggregate internally, respond with one JSON object.
  // ------------------------------------------------------------------
  if (!wantsStream) {
    const builder = new CompletionBuilder()
    for await (const event of events) {
      if (event === "done") break
      builder.addEvent(event as unknown as UpstreamEvent)
    }
    return new Response(JSON.stringify(builder.build(completionId, created)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  // ------------------------------------------------------------------
  // Streaming: raise each upstream event into chat chunks over SSE.
  // ------------------------------------------------------------------
  const encoder = new TextEncoder()
  const raiser = createRaiser({ id: completionId, created, model: MODEL_ID })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const push = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text))
      }

      // Edge platforms may buffer; the heartbeat comment keeps
      // intermediaries from closing an idle connection while the model
      // thinks. The timer self-cleans when the stream closes.
      const heartbeat = setInterval(() => push(HEARTBEAT_COMMENT), HEARTBEAT_INTERVAL_MS)

      try {
        push(chunkToSse({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: MODEL_ID,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        }))

        for await (const event of events) {
          if (event === "done") break
          for (const chunkOut of raiser.handle(event as unknown as UpstreamEvent)) {
            push(chunkToSse(chunkOut))
          }
        }
        const finishChunks = raiser.finish()
        for (const chunkOut of finishChunks) push(chunkToSse(chunkOut))
        push(DONE_LINE)
      } catch (error) {
        // Mid-stream failure: surface an OpenAI-ish error chunk, then close.
        const message = error instanceof Error ? error.message : "stream interrupted"
        push(chunkToSse(errorChunk(completionId, created, MODEL_ID, message)))
        push(DONE_LINE)
      } finally {
        clearInterval(heartbeat)
        if (!closed) {
          closed = true
          controller.close()
        }
      }
    },
    cancel() {
      // Client disconnected; request.signal already aborts the upstream fetch.
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  })
}

// Vercel handler shell (Node.js runtime, Web-standard fetch export).
async function handler(request: Request): Promise<Response> {
  return handleChatRequest(request, { PROXY_API_KEY: process.env.PROXY_API_KEY })
}

export default { fetch: handler }
export { handler as POST, handler as GET }

// Re-exported for tests.
export { MODEL_NAME }

// Local type re-exports used by integration tests.
export type { ChatToolCall }
