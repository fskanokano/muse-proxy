// POST /v1/chat/completions (Supabase Edge Function `muse-proxy`) — the main facade.
//
// Pipeline: auth -> lower (chat -> Responses) -> fetch opencode zen -> raise
// (Responses SSE -> chat chunks) -> SSE out (or aggregated JSON for
// stream:false).

import { checkAuth } from "./_lib/auth.ts"
import { errorChunk, jsonError, upstreamErrorToOpenAI } from "./_lib/errors.ts"
import { identityForCall } from "./_lib/identity.ts"
import { lowerRequest } from "./_lib/lower.ts"
import { createRaiser } from "./_lib/raise.ts"
import { chunkToSse, DONE_LINE, HEARTBEAT_COMMENT, HEARTBEAT_INTERVAL_MS, parseUpstreamSse } from "./_lib/sse.ts"
import { shouldExposeToolCall } from "./_lib/tools.ts"
import type { ChatToolCall, ChatUsage, UpstreamEvent } from "./_lib/types.ts"
import { resolveModel } from "./_lib/types.ts"
import { usageToChat } from "./_lib/usage.ts"
import { handleOaCompatUpstream } from "./_lib/oa-compat.ts"
import { MODEL_ID, MODEL_NAME, OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_URL, UPSTREAM_USER_AGENT } from "./_lib/types.ts"

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

function isExposedChatTool(name: string, clientToolNames: ReadonlySet<string>, toolChoice: unknown): boolean {
  if (toolChoice === "none") return false
  if (typeof toolChoice === "object" && toolChoice !== null && !Array.isArray(toolChoice)) {
    const record = toolChoice as Record<string, unknown>
    if (record.type === "function" && typeof record.function === "object" && record.function !== null && !Array.isArray(record.function)) {
      const forced = (record.function as Record<string, unknown>).name
      if (typeof forced === "string") return name === forced
    }
  }
  return shouldExposeToolCall(name, clientToolNames)
}

// Aggregate streamed chunks into a non-streaming chat.completion object.
class CompletionBuilder {
  content = ""
  reasoning = ""
  toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = []
  finishReason: string | null = null
  usage: ChatUsage | undefined
  clientToolNames: ReadonlySet<string> = new Set<string>()
  toolChoice: unknown = undefined

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
      const name = event.item.name
      if (callId && name && isExposedChatTool(name, this.clientToolNames, this.toolChoice)) {
        this.toolCalls.push({
          id: callId,
          type: "function",
          function: { name, arguments: event.item.arguments ?? "" },
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

  build(id: string, created: number, model: string): Record<string, unknown> {
    const message: Record<string, unknown> = { role: "assistant", content: this.content }
    if (this.reasoning.length > 0) message.reasoning_content = this.reasoning
    if (this.toolCalls.length > 0) message.tool_calls = this.toolCalls
    const body: Record<string, unknown> = {
      id,
      object: "chat.completion",
      created,
      model,
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

  const chat = chatBody as { stream?: boolean; tool_choice?: unknown }
  const wantsStream = chat.stream === true
  const clientToolChoice = chat.tool_choice

  const completionId = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  // Mint the opencode identity BEFORE lowering so the session id can double
  // as the upstream prompt_cache_key (the CLI sends its session id there).
  const identity = identityForCall(completionId)
  const lowered = lowerRequest(chatBody, { sessionId: identity.sessionId })
  if ("error" in lowered) {
    return jsonResponse(jsonError(lowered.error.status, lowered.error.message, lowered.error.code))
  }

  // Model routing: the two new free models live on the oa-compat format
  // (/v1/chat/completions upstream); muse keeps the untouched Responses path.
  const resolved = resolveModel((chatBody as { model?: unknown }).model)
  if (resolved.upstream === "oa-compat") {
    return handleOaCompatUpstream(
      {
        callId: completionId,
        identity,
        model: resolved,
        input: lowered.request.input,
        tools: lowered.request.tools ?? [],
        effort: lowered.request.reasoning?.effort,
        temperature: lowered.request.temperature,
        topP: lowered.request.top_p,
        maxOutputTokens: lowered.request.max_output_tokens,
        signal: request.signal,
        fetchImpl,
        renderUpstreamError: (status, body) => jsonResponse(upstreamErrorToOpenAI(status, body)),
        renderNetworkError: (message) =>
          jsonResponse(jsonError(502, message, "upstream_unreachable", "api_error")),
      },
      async (events) => {
        // Non-streaming: aggregate internally, respond with one JSON object.
        if (!wantsStream) {
          const builder = new CompletionBuilder()
          builder.clientToolNames = lowered.clientToolNames
          builder.toolChoice = clientToolChoice
          for await (const event of events) {
            if (event === "done") break
            builder.addEvent(event as unknown as UpstreamEvent)
          }
          return new Response(JSON.stringify(builder.build(completionId, created, resolved.id)), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        // Streaming: raise each upstream event into chat chunks over SSE.
        const encoder = new TextEncoder()
        const raiser = createRaiser({
          id: completionId,
          created,
          model: resolved.id,
          clientToolNames: lowered.clientToolNames,
          toolChoice: clientToolChoice,
        })
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let closed = false
            const push = (text: string) => {
              if (!closed) controller.enqueue(encoder.encode(text))
            }
            const heartbeat = setInterval(() => push(HEARTBEAT_COMMENT), HEARTBEAT_INTERVAL_MS)
            try {
              push(
                chunkToSse({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: resolved.id,
                  choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
                }),
              )
              for await (const event of events) {
                if (event === "done") break
                for (const chunkOut of raiser.handle(event as unknown as UpstreamEvent)) {
                  push(chunkToSse(chunkOut))
                }
              }
              for (const chunkOut of raiser.finish()) push(chunkToSse(chunkOut))
              push(DONE_LINE)
            } catch (error) {
              const message = error instanceof Error ? error.message : "stream interrupted"
              push(chunkToSse(errorChunk(completionId, created, resolved.id, message)))
              push(DONE_LINE)
            } finally {
              clearInterval(heartbeat)
              if (!closed) {
                closed = true
                controller.close()
              }
            }
          },
          cancel() {},
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
      },
    )
  }

  let upstream: Response
  try {
    // Full opencode client header fingerprint (captured from a real 1.18.31
    // CLI request): ai-sdk/runtime-suffixed UA, client flag, opencode-shaped
    // session/request ids, and project:"global". The zen free tier rejects
    // any deviation with 403 FreeTierError.
    upstream = await fetchImpl(UPSTREAM_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${UPSTREAM_API_KEY}`,
        "content-type": "application/json",
        accept: "*/*",
        // Free tier is UA-gated; without a CLI-faithful UA upstream rejects.
        "user-agent": UPSTREAM_USER_AGENT,
        // Required by the responses endpoint (MissingSessionID otherwise).
        // Stateless proxy: opencode-shaped ses_/msg_ ids per upstream call;
        // mirrors opencode's `x-opencode-session: sessionID` (request.ts).
        "x-opencode-session": identity.sessionId,
        "x-opencode-request": identity.requestId,
        "x-opencode-client": OPENCODE_CLIENT,
        "x-opencode-project": OPENCODE_PROJECT_ID,
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
    builder.clientToolNames = lowered.clientToolNames
    builder.toolChoice = clientToolChoice
    for await (const event of events) {
      if (event === "done") break
      builder.addEvent(event as unknown as UpstreamEvent)
    }
    return new Response(JSON.stringify(builder.build(completionId, created, MODEL_ID)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  // ------------------------------------------------------------------
  // Streaming: raise each upstream event into chat chunks over SSE.
  // ------------------------------------------------------------------
  const encoder = new TextEncoder()
  const raiser = createRaiser({ id: completionId, created, model: MODEL_ID, clientToolNames: lowered.clientToolNames, toolChoice: clientToolChoice })

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

// Re-exported for tests.
export { MODEL_NAME }

// Local type re-exports used by integration tests.
export type { ChatToolCall }
