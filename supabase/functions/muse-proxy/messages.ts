// POST /v1/messages (Supabase Edge Function `muse-proxy`) — Anthropic Messages API
// facade, independent from the chat completions (api/chat.ts) and Responses
// (api/responses.ts) facades.
//
// Pipeline: auth -> lowerMessagesRequest (Anthropic body -> upstream
// Responses body, re-applying the muse fingerprint rules) -> fetch opencode
// zen -> raise upstream events into Anthropic SSE (stream:true) or an
// aggregated `message` object (stream:false).
//
// Auth follows the Anthropic SDK convention (`x-api-key` header; the shared
// checkAuth also accepts `Authorization: Bearer`) and uses the SAME
// PROXY_API_KEY env var as the other facades. Errors use the Anthropic
// error envelope: {"type":"error","error":{"type":...,"message":...}}.

import { checkAuth } from "./_lib/auth.ts"
import { identityForCall } from "./_lib/identity.ts"
import { MessageRaiser, type AnthropicEvent } from "./_lib/messages-raise.ts"
import { lowerMessagesRequest } from "./_lib/messages-lower.ts"
import { HEARTBEAT_COMMENT, HEARTBEAT_INTERVAL_MS, parseUpstreamSse } from "./_lib/sse.ts"
import { shouldExposeToolCall } from "./_lib/tools.ts"
import type { UpstreamEvent, UpstreamUsage } from "./_lib/types.ts"
import { MODEL_ID, OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_URL, UPSTREAM_USER_AGENT, resolveModel } from "./_lib/types.ts"
import { handleOaCompatUpstream } from "./_lib/oa-compat.ts"

export interface MessagesEnv {
  PROXY_API_KEY?: string
}

export interface MessagesDependencies {
  fetchImpl?: typeof fetch
}

type FetchFn = typeof fetch

// ---------------------------------------------------------------------------
// Anthropic-shaped errors
// ---------------------------------------------------------------------------

function anthropicError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function extractUpstreamMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const record = body as Record<string, unknown>
  const error = record.error
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === "string") return message
  }
  if (typeof record.message === "string") return record.message
  return undefined
}

// Map an upstream non-2xx response onto the Anthropic error envelope with the
// same status mapping as the other facades (429/400 keep their status; the
// rest become 502).
function upstreamErrorToAnthropic(status: number, upstreamBody: unknown): Response {
  const detail = extractUpstreamMessage(upstreamBody) ?? `upstream error ${status}`
  if (status === 429) return anthropicError(429, "rate_limit_error", detail)
  if (status === 400) return anthropicError(400, "invalid_request_error", detail)
  return anthropicError(502, "api_error", `upstream rejected credentials (${status}): ${detail}`)
}

function isExposedMessagesTool(name: string, clientToolNames: ReadonlySet<string>, toolChoice: unknown): boolean {
  if (toolChoice === "none") return false
  if (typeof toolChoice === "object" && toolChoice !== null && !Array.isArray(toolChoice)) {
    const record = toolChoice as Record<string, unknown>
    if (record.type === "tool" && typeof record.name === "string") return name === record.name
    if (record.type === "any" || record.type === "auto") return shouldExposeToolCall(name, clientToolNames)
  }
  return shouldExposeToolCall(name, clientToolNames)
}
// ---------------------------------------------------------------------------
// Non-streaming aggregation: rebuild an Anthropic `message` object from the
// upstream SSE event stream.
// ---------------------------------------------------------------------------

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }

export class MessageBuilder {
  content: ContentBlock[] = []
  stopReason: "end_turn" | "max_tokens" | "tool_use" = "end_turn"
  usage: UpstreamUsage = { input_tokens: 0, output_tokens: 0 }
  error: { code: string | null; message: string } | null = null
  sawTerminalEvent = false
  clientToolNames: ReadonlySet<string> = new Set<string>()
  toolChoice: unknown = undefined

  private appendToBlock(type: "text" | "thinking", delta: string): void {
    const last = this.content.at(-1)
    if (type === "text") {
      if (last && last.type === "text") {
        last.text += delta
        return
      }
      this.content.push({ type: "text", text: delta })
      return
    }
    if (last && last.type === "thinking") {
      last.thinking += delta
      return
    }
    this.content.push({ type: "thinking", thinking: delta })
  }

  addEvent(raw: Record<string, unknown>) {
    const event = raw as unknown as UpstreamEvent

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      this.appendToBlock("text", event.delta)
      return
    }
    if (
      (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") &&
      typeof event.delta === "string"
    ) {
      this.appendToBlock("thinking", event.delta)
      return
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const callId = event.item.call_id ?? event.item.id
      const name = event.item.name
      if (callId && name && isExposedMessagesTool(name, this.clientToolNames, this.toolChoice)) {
        let input: Record<string, unknown>
        try {
          input = JSON.parse(event.item.arguments ?? "{}") as Record<string, unknown>
        } catch {
          input = { _unparsed: event.item.arguments ?? "" }
        }
        this.content.push({ type: "tool_use", id: callId, name, input })
      }
      return
    }
    if (event.type === "response.completed") {
      this.sawTerminalEvent = true
      this.stopReason = this.content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn"
      if (event.response?.usage) this.usage = event.response.usage
      return
    }
    if (event.type === "response.incomplete") {
      this.sawTerminalEvent = true
      this.stopReason = "max_tokens"
      if (event.response?.usage) this.usage = event.response.usage
      return
    }
    if (event.type === "response.failed" || event.type === "error") {
      this.sawTerminalEvent = true
      const code = event.code ?? event.response?.error?.code ?? null
      const message = event.message ?? event.response?.error?.message ?? "unknown upstream error"
      this.error = { code: typeof code === "string" ? code : null, message }
    }
  }

  build(id: string, model: string): Record<string, unknown> {
    return {
      id,
      type: "message",
      role: "assistant",
      model,
      content: this.content,
      stop_reason: this.stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: this.usage.input_tokens ?? 0,
        output_tokens: this.usage.output_tokens ?? 0,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMessagesRequest(
  request: Request,
  env: MessagesEnv,
  dependencies: MessagesDependencies = {},
): Promise<Response> {
  const fetchImpl: FetchFn = dependencies.fetchImpl ?? fetch

  if (!checkAuth(request, env)) {
    return anthropicError(401, "authentication_error", "invalid or missing proxy API key")
  }
  if (request.method !== "POST") {
    return anthropicError(405, "invalid_request_error", "method not allowed")
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return anthropicError(400, "invalid_request_error", "request body must be valid JSON")
  }

  const messageId = `msg_${crypto.randomUUID()}`
  const parsedBody = (rawBody as { stream?: boolean; tool_choice?: unknown } | null) ?? {}
  const wantsStream = parsedBody.stream === true
  const clientToolChoice = parsedBody.tool_choice

  // Mint the opencode identity BEFORE lowering so the session id can
  // double as the upstream prompt_cache_key (same contract as the other
  // facades).
  const identity = identityForCall(messageId)
  const lowered = lowerMessagesRequest(rawBody, { sessionId: identity.sessionId })
  if ("error" in lowered) {
    return anthropicError(lowered.error.status, "invalid_request_error", lowered.error.message)
  }

  // Model routing: the two new free models live on the oa-compat format
  // (/v1/chat/completions upstream); muse keeps the untouched Responses path.
  const resolved = resolveModel((rawBody as { model?: unknown } | null)?.model)
  if (resolved.upstream === "oa-compat") {
    return handleOaCompatUpstream(
      {
        callId: messageId,
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
        renderUpstreamError: (status, body) => upstreamErrorToAnthropic(status, body),
        renderNetworkError: (message) => anthropicError(502, "api_error", message),
      },
      async (events) => {
        // Non-streaming: aggregate internally, respond with one JSON message.
        if (!wantsStream) {
          const builder = new MessageBuilder()
          builder.clientToolNames = lowered.clientToolNames
          builder.toolChoice = clientToolChoice
          for await (const event of events) {
            if (event === "done") break
            builder.addEvent(event)
          }
          if (builder.error) {
            return anthropicError(502, "api_error", builder.error.message)
          }
          if (!builder.sawTerminalEvent) {
            return anthropicError(502, "api_error", "upstream closed the stream before a terminal response event")
          }
          return new Response(JSON.stringify(builder.build(messageId, resolved.id)), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        // Streaming: raise each upstream event into Anthropic SSE events.
        const encoder = new TextEncoder()
        const raiser = new MessageRaiser({
          messageId,
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
            const frameEvent = (event: AnthropicEvent): string => {
              const data = `data: ${JSON.stringify(event)}\n\n`
              return `event: ${event.type}\n${data}`
            }
            try {
              push(frameEvent(raiser.start()))
              for await (const event of events) {
                if (event === "done") break
                if (event.type === "ping") continue
                for (const out of raiser.handle(event as unknown as UpstreamEvent)) {
                  push(frameEvent(out))
                }
              }
              for (const out of raiser.finish()) {
                push(frameEvent(out))
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : "stream interrupted"
              push(frameEvent({ type: "error", error: { type: "api_error", message } }))
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
    // Identical opencode client header fingerprint as the other facades —
    // the zen free tier gates on it regardless of which facade was used.
    upstream = await fetchImpl(UPSTREAM_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${UPSTREAM_API_KEY}`,
        "content-type": "application/json",
        accept: "*/*",
        "user-agent": UPSTREAM_USER_AGENT,
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
    return anthropicError(502, "api_error", `failed to reach opencode zen: ${message}`)
  }

  if (!upstream.ok || upstream.body === null) {
    let upstreamJson: unknown = null
    try {
      upstreamJson = await upstream.json()
    } catch {
      upstreamJson = null
    }
    return upstreamErrorToAnthropic(upstream.status, upstreamJson)
  }

  const events: AsyncGenerator<Record<string, unknown> | "done"> = parseUpstreamSse(upstream.body)

  // ------------------------------------------------------------------
  // Non-streaming: aggregate internally, respond with one JSON message.
  // ------------------------------------------------------------------
  if (!wantsStream) {
    const builder = new MessageBuilder()
    builder.clientToolNames = lowered.clientToolNames
    builder.toolChoice = clientToolChoice
    for await (const event of events) {
      if (event === "done") break
      builder.addEvent(event)
    }
    if (builder.error) {
      // Upstream surfaced a terminal failure: return it as an error body.
      return anthropicError(502, "api_error", builder.error.message)
    }
    if (!builder.sawTerminalEvent) {
      // Upstream EOFed without any terminal event: the aggregated output is
      // truncated, so never report it as a complete message.
      return anthropicError(502, "api_error", "upstream closed the stream before a terminal response event")
    }
    return new Response(JSON.stringify(builder.build(messageId, MODEL_ID)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  // ------------------------------------------------------------------
  // Streaming: raise each upstream event into Anthropic SSE events,
  // framed as `event: <type>` + `data: <json>` (no [DONE]; the stream
  // ends with message_stop, per the Anthropic contract).
  // ------------------------------------------------------------------
  const encoder = new TextEncoder()
  const raiser = new MessageRaiser({ messageId, model: MODEL_ID, clientToolNames: lowered.clientToolNames, toolChoice: clientToolChoice })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const push = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text))
      }

      const heartbeat = setInterval(() => push(HEARTBEAT_COMMENT), HEARTBEAT_INTERVAL_MS)

      const frameEvent = (event: AnthropicEvent): string => {
        const data = `data: ${JSON.stringify(event)}\n\n`
        return `event: ${event.type}\n${data}`
      }

      try {
        push(frameEvent(raiser.start()))
        for await (const event of events) {
          if (event === "done") break
          // opencode zen interleaves non-spec `ping` keep-alive frames in
          // the event stream; the proxy's own heartbeat comments already
          // keep the connection alive, so drop them here.
          if (event.type === "ping") continue
          for (const out of raiser.handle(event as unknown as UpstreamEvent)) {
            push(frameEvent(out))
          }
        }
        for (const out of raiser.finish()) {
          push(frameEvent(out))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "stream interrupted"
        push(frameEvent({ type: "error", error: { type: "api_error", message } }))
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


