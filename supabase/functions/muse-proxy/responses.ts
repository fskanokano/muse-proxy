// POST /v1/responses (Supabase Edge Function `muse-proxy`) — OpenAI Responses API
// facade, independent from the chat completions facade in api/chat.ts.
//
// Pipeline: auth -> normalizeResponsesRequest (Responses body -> upstream
// Responses body, re-applying the muse fingerprint rules) -> fetch opencode
// zen -> SSE passthrough (stream:true) or aggregated `response` object
// (stream:false).
//
// Because the upstream already speaks the Responses API, streaming forwards
// upstream events verbatim (re-framed as `event:`/`data:` SSE records, with
// non-spec `ping` keep-alives dropped and a synthetic error event if the
// upstream EOFs without a terminal event) and non-streaming aggregates the
// same events into a single response object.

import { checkAuth } from "./_lib/auth.ts"
import { jsonError, upstreamErrorToOpenAI } from "./_lib/errors.ts"
import { identityForCall } from "./_lib/identity.ts"
import { normalizeResponsesRequest } from "./_lib/responses-lower.ts"
import { HEARTBEAT_COMMENT, HEARTBEAT_INTERVAL_MS, parseUpstreamSse } from "./_lib/sse.ts"
import { shouldExposeToolCall } from "./_lib/tools.ts"
import type { UpstreamEvent, UpstreamUsage } from "./_lib/types.ts"
import { DEFAULT_REASONING_EFFORT, MODEL_ID, OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_URL, UPSTREAM_USER_AGENT, resolveModel } from "./_lib/types.ts"
import { handleOaCompatUpstream } from "./_lib/oa-compat.ts"

export interface ResponsesEnv {
  PROXY_API_KEY?: string
}

export interface ResponsesDependencies {
  fetchImpl?: typeof fetch
}

type FetchFn = typeof fetch

function jsonResponse(res: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(res.body), {
    status: res.status,
    headers: { "content-type": "application/json" },
  })
}

// ---------------------------------------------------------------------------
// Non-streaming aggregation: rebuild a Responses `response` object from the
// upstream SSE event stream.
// ---------------------------------------------------------------------------

type OutputItem = Record<string, unknown>

interface AggregatedUsage extends UpstreamUsage {}

export class ResponseBuilder {
  output: OutputItem[] = []
  outputText = ""
  status: "completed" | "incomplete" | "failed" = "completed"
  incompleteDetails: { reason: string } | null = null
  error: { code: string | null; message: string } | null = null
  usage: AggregatedUsage | undefined
  upstreamResponseId: string | undefined
  /** True once a terminal event (completed/incomplete/failed/error) was seen. */
  sawTerminalEvent = false
  clientToolNames: ReadonlySet<string> = new Set<string>()
  nsPrefixByBare: ReadonlyMap<string, string> = new Map<string, string>()
  customToolNames: ReadonlySet<string> = new Set<string>()

  addEvent(raw: Record<string, unknown>) {
    const event = raw as unknown as UpstreamEvent

    if (
      (event.type === "response.created" || event.type === "response.in_progress") &&
      typeof event.response?.id === "string"
    ) {
      this.upstreamResponseId = event.response.id
      return
    }

    if (event.type === "response.output_item.done" && event.item) {
      const item = event.item as unknown as OutputItem & { name?: unknown; arguments?: unknown }
      if (item.type === "function_call" && typeof item.name === "string") {
        const toolName: string = item.name
        // custom 转写工具（如 codex exec）：下行重写为原生 custom_tool_call，
        // 本地线程执行器只接受 custom 信封，function 形必报 incompatible payload。
        if (this.customToolNames.has(toolName)) {
          const rawArgs = typeof item.arguments === "string" ? item.arguments : "{}"
          let input = rawArgs
          try {
            const parsed: unknown = JSON.parse(rawArgs)
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              const record = parsed as Record<string, unknown>
              const inner = record.input ?? record.code
              if (typeof inner === "string") input = inner
            }
          } catch {}
          const rewritten: Record<string, unknown> = { ...(item as Record<string, unknown>), type: "custom_tool_call", input }
          delete rewritten.arguments
          this.output.push(rewritten)
          return
        }
        const prefix = this.nsPrefixByBare.get(toolName)
        if (prefix !== undefined && !toolName.startsWith(`${prefix}__`)) item.name = `${prefix}__${toolName}`
        if (!shouldExposeToolCall(item.name as string, this.clientToolNames)) return
      }
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          const p = part as { type?: string; text?: string }
          if ((p.type === "output_text" || p.type === "refusal") && typeof p.text === "string") {
            this.outputText += p.text
          }
        }
      }
      this.output.push(item)
      return
    }

    if (event.type === "response.completed") {
      this.status = "completed"
      this.sawTerminalEvent = true
      if (event.response?.usage) this.usage = event.response.usage
      return
    }

    if (event.type === "response.incomplete") {
      this.status = "incomplete"
      this.sawTerminalEvent = true
      if (event.response?.usage) this.usage = event.response.usage
      const reason = event.response?.incomplete_details?.reason
      this.incompleteDetails = typeof reason === "string" ? { reason } : null
      return
    }

    if (event.type === "response.failed" || event.type === "error") {
      this.status = "failed"
      this.sawTerminalEvent = true
      const code = event.code ?? event.response?.error?.code ?? null
      const message = event.message ?? event.response?.error?.message ?? "unknown upstream error"
      this.error = { code: typeof code === "string" ? code : null, message }
      return
    }
  }

  build(fallbackId: string, createdAt: number, echo: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = {
      id: this.upstreamResponseId ?? fallbackId,
      object: "response",
      created_at: createdAt,
      status: this.status,
      model: MODEL_ID,
      output: this.output,
      output_text: this.outputText,
      error: this.error,
      incomplete_details: this.incompleteDetails,
      usage: this.usage ?? null,
      parallel_tool_calls: true,
      metadata: {},
      store: false,
      ...echo,
    }
    return body
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleResponsesRequest(
  request: Request,
  env: ResponsesEnv,
  dependencies: ResponsesDependencies = {},
): Promise<Response> {
  const fetchImpl: FetchFn = dependencies.fetchImpl ?? fetch

  if (!checkAuth(request, env)) {
    return jsonResponse(jsonError(401, "invalid or missing proxy API key", "invalid_proxy_key", "authentication_error"))
  }
  if (request.method !== "POST") {
    return jsonResponse(jsonError(405, "method not allowed", "method_not_allowed"))
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return jsonResponse(jsonError(400, "request body must be valid JSON"))
  }

  const responseId = `resp_${crypto.randomUUID()}`
  const createdAt = Math.floor(Date.now() / 1000)

  // Mint the opencode identity BEFORE normalizing so the session id can
  // double as the upstream prompt_cache_key (same contract as api/chat.ts).
  const identity = identityForCall(responseId)
  const normalized = normalizeResponsesRequest(rawBody, { sessionId: identity.sessionId })
  if ("error" in normalized) {
    return jsonResponse(jsonError(normalized.error.status, normalized.error.message, normalized.error.code))
  }
  const wantsStream = normalized.stream

  // Model routing: the two new free models live on the oa-compat format
  // (/v1/chat/completions upstream); muse keeps the untouched Responses path.
  const resolved = resolveModel((rawBody as { model?: unknown } | null)?.model)
  if (resolved.upstream === "oa-compat") {
    return handleOaCompatUpstream(
      {
        callId: responseId,
        identity,
        model: resolved,
        input: normalized.request.input,
        tools: normalized.request.tools ?? [],
        effort: normalized.request.reasoning?.effort,
        temperature: normalized.request.temperature,
        topP: normalized.request.top_p,
        maxOutputTokens: normalized.request.max_output_tokens,
        signal: request.signal,
        fetchImpl,
        renderUpstreamError: (status, body) => jsonResponse(upstreamErrorToOpenAI(status, body)),
        renderNetworkError: (message) =>
          jsonResponse(jsonError(502, message, "upstream_unreachable", "api_error")),
      },
      async (events) => {
        // Non-streaming: aggregate internally, respond with one JSON object.
        if (!wantsStream) {
          const builder = new ResponseBuilder()
          builder.clientToolNames = normalized.clientToolNames
          builder.nsPrefixByBare = normalized.nsPrefixByBare
          for await (const event of events) {
            if (event === "done") break
            builder.addEvent(event)
          }
          if (builder.status === "failed") {
            return jsonResponse(jsonError(502, builder.error?.message ?? "upstream error", builder.error?.code ?? "upstream_error", "api_error"))
          }
          if (!builder.sawTerminalEvent) {
            return jsonResponse(jsonError(502, "upstream closed the stream before a terminal response event", "upstream_stream_truncated", "api_error"))
          }
          const echo: Record<string, unknown> = {
            model: resolved.id,
            temperature: normalized.request.temperature ?? null,
            top_p: normalized.request.top_p ?? null,
            max_output_tokens: normalized.request.max_output_tokens ?? null,
            tool_choice: "auto",
            reasoning: { effort: normalized.request.reasoning?.effort ?? DEFAULT_REASONING_EFFORT, summary: "auto" },
          }
          return new Response(JSON.stringify(builder.build(responseId, createdAt, echo)), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        // Streaming: re-frame raised events as canonical Responses SSE.
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let closed = false
            const push = (text: string) => {
              if (!closed) controller.enqueue(encoder.encode(text))
            }
            const heartbeat = setInterval(() => push(HEARTBEAT_COMMENT), HEARTBEAT_INTERVAL_MS)
            const frameEvent = (event: Record<string, unknown>): string => {
              const type = typeof event.type === "string" ? event.type : undefined
              const data = `data: ${JSON.stringify(event)}\n\n`
              return type !== undefined ? `event: ${type}\n${data}` : data
            }
            try {
              let sawTerminalEvent = false
              const clientToolNames = normalized.clientToolNames
              // Mirror the muse-path hidden-builtin filtering: drop builtin
              // tool calls the client cannot execute across the whole event
              // sequence (added/delta/done + terminal response.output).
              const hiddenItemIds = new Set<string>()
              for await (const event of events) {
                if (event === "done") break
                if (event.type === "ping") continue
                if (event.type === "response.output_item.added") {
                  const item = event.item as Record<string, unknown> | undefined
                  if (item?.type === "function_call" && typeof item.name === "string" && !shouldExposeToolCall(item.name, clientToolNames)) {
                    if (typeof item.id === "string") hiddenItemIds.add(item.id)
                    continue
                  }
                }
                if (event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done") {
                  const itemId = typeof event.item_id === "string" ? event.item_id : undefined
                  const name = typeof event.name === "string" ? event.name : undefined
                  if ((itemId !== undefined && hiddenItemIds.has(itemId)) || (name !== undefined && !shouldExposeToolCall(name, clientToolNames))) {
                    continue
                  }
                }
                if (event.type === "response.output_item.done") {
                  const item = (event as Record<string, unknown>).item as Record<string, unknown> | undefined
                  if (item?.type === "function_call" && typeof item.name === "string" && !shouldExposeToolCall(item.name, clientToolNames)) {
                    if (typeof item.id === "string") hiddenItemIds.delete(item.id)
                    continue
                  }
                }
                if (event.type === "response.completed" || event.type === "response.incomplete") {
                  const response = event.response as Record<string, unknown> | undefined
                  const output = response?.output
                  if (response && Array.isArray(output)) {
                    response.output = output.filter((entry) => {
                      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return true
                      const record = entry as Record<string, unknown>
                      return !(record.type === "function_call" && typeof record.name === "string" && !shouldExposeToolCall(record.name, clientToolNames))
                    })
                  }
                  sawTerminalEvent = true
                } else if (event.type === "response.failed" || event.type === "error") {
                  sawTerminalEvent = true
                }
                push(frameEvent(event))
              }
              if (!sawTerminalEvent) {
                push(frameEvent({
                  type: "error",
                  code: "upstream_stream_truncated",
                  message: "upstream closed the stream before a terminal response event",
                }))
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : "stream interrupted"
              push(frameEvent({ type: "error", code: "proxy_stream_error", message }))
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
    // Identical opencode client header fingerprint as api/chat.ts — the zen
    // free tier gates on it regardless of which facade the client used.
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
      body: JSON.stringify(normalized.request),
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
  if (!wantsStream) {
    const builder = new ResponseBuilder()
    builder.clientToolNames = normalized.clientToolNames
    builder.nsPrefixByBare = normalized.nsPrefixByBare
    builder.customToolNames = normalized.customToolNames
    for await (const event of events) {
      if (event === "done") break
      builder.addEvent(event)
    }
    if (builder.status === "failed") {
      // Upstream surfaced a terminal failure: return it as an error body.
      return jsonResponse(jsonError(502, builder.error?.message ?? "upstream error", builder.error?.code ?? "upstream_error", "api_error"))
    }
    if (!builder.sawTerminalEvent) {
      // Upstream EOFed without any terminal event: the aggregated output is
      // truncated, so never report it as a completed response.
      return jsonResponse(jsonError(502, "upstream closed the stream before a terminal response event", "upstream_stream_truncated", "api_error"))
    }
    const echo: Record<string, unknown> = {
      temperature: normalized.request.temperature ?? null,
      top_p: normalized.request.top_p ?? null,
      max_output_tokens: normalized.request.max_output_tokens ?? null,
      tool_choice: "auto",
      reasoning: { effort: normalized.request.reasoning?.effort ?? DEFAULT_REASONING_EFFORT, summary: "auto" },
    }
    return new Response(JSON.stringify(builder.build(responseId, createdAt, echo)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  // ------------------------------------------------------------------
  // Streaming: re-frame upstream events as canonical Responses SSE
  // (`event: <type>` + `data: <json>`), verbatim payload passthrough.
  // ------------------------------------------------------------------
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const push = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text))
      }

      const heartbeat = setInterval(() => push(HEARTBEAT_COMMENT), HEARTBEAT_INTERVAL_MS)

      const frameEvent = (event: Record<string, unknown>): string => {
        const type = typeof event.type === "string" ? event.type : undefined
        const data = `data: ${JSON.stringify(event)}\n\n`
        return type !== undefined ? `event: ${type}\n${data}` : data
      }

      try {
        let sawTerminalEvent = false
        const clientToolNames = normalized.clientToolNames
        const customToolNames = normalized.customToolNames
        // 隐藏内置工具调用的 item id 集合：output_item.added 里记下，
        // 后续 arguments.delta/done 按 item_id 丢弃。必须全序列丢弃
        // （added + delta + done + output_item.done）：只丢 done 会留下
        // 有头无尾的 tool-call，客户端 SDK 在 response.completed 到达时
        // 发现 pending arguments 未完成，直接报 stream protocol error。
        const hiddenItemIds = new Set<string>()
        for await (const event of events) {
          if (event === "done") break
          // opencode zen interleaves `ping` keep-alive frames inside the
          // event stream (including after response.completed). They are not
          // part of the OpenAI Responses event contract and would otherwise
          // break clients that expect response.completed to terminate the
          // stream; the proxy's own heartbeat comments already keep the
          // connection alive, so drop them here.
          if (event.type === "ping") continue
          if (event.type === "response.output_item.added") {
            const item = event.item as Record<string, unknown> | undefined
            if (item?.type === "function_call" && typeof item.name === "string" && customToolNames.has(item.name)) {
              // custom 转写工具新增事件同步重写，本地执行器按 custom 信封建调用。
              const rewritten: Record<string, unknown> = { ...(item as Record<string, unknown>), type: "custom_tool_call", input: "" }
              delete rewritten.arguments
              push(frameEvent({ ...(event as Record<string, unknown>), item: rewritten }))
              continue
            }
            if (item?.type === "function_call" && typeof item.name === "string" && !shouldExposeToolCall(item.name, clientToolNames)) {
              if (typeof item.id === "string") hiddenItemIds.add(item.id)
              continue
            }
          }
          if (event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done") {
            const itemId = typeof event.item_id === "string" ? event.item_id : undefined
            const name = typeof event.name === "string" ? event.name : undefined
            if ((itemId !== undefined && hiddenItemIds.has(itemId)) || (name !== undefined && !shouldExposeToolCall(name, clientToolNames))) {
              continue
            }
          }
          if (event.type === "response.output_item.done") {
            const item = (event as Record<string, unknown>).item as Record<string, unknown> | undefined
            if (item?.type === "function_call" && typeof item.name === "string" && customToolNames.has(item.name)) {
              const argsText = typeof item.arguments === "string" ? item.arguments : "{}"
              let input = argsText
              try {
                const parsed: unknown = JSON.parse(argsText)
                if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                  const record = parsed as Record<string, unknown>
                  const inner = record.input ?? record.code
                  if (typeof inner === "string") input = inner
                }
              } catch {}
              const rewritten: Record<string, unknown> = { ...(item as Record<string, unknown>), type: "custom_tool_call", input }
              delete rewritten.arguments
              push(frameEvent({ ...(event as Record<string, unknown>), item: rewritten }))
              continue
            }
            const doneItem = (event as Record<string, unknown>).item as Record<string, unknown> | undefined
            if (doneItem?.type === "function_call" && typeof doneItem.name === "string" && !shouldExposeToolCall(doneItem.name, clientToolNames)) {
              if (typeof doneItem.id === "string") hiddenItemIds.delete(doneItem.id)
              continue
            }
          }
          if (event.type === "response.completed" || event.type === "response.incomplete") {
            // 终端事件自带的 response.output 数组也可能含隐藏调用：剥离，
            // 否则客户端解析 completed 时仍会看到无头尾的 tool-call。
            const response = event.response as Record<string, unknown> | undefined
            const output = response?.output
            if (response && Array.isArray(output)) {
              response.output = output
                .filter((entry) => {
                  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return true
                  const record = entry as Record<string, unknown>
                  return !(record.type === "function_call" && typeof record.name === "string" && !shouldExposeToolCall(record.name, clientToolNames))
                })
                .map((entry) => {
                  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry
                  const record = entry as Record<string, unknown>
                  if (record.type === "function_call" && typeof record.name === "string" && customToolNames.has(record.name)) {
                    const argsText = typeof record.arguments === "string" ? record.arguments : "{}"
                    let input = argsText
                    try {
                      const parsed: unknown = JSON.parse(argsText)
                      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                        const inner = (parsed as Record<string, unknown>).input ?? (parsed as Record<string, unknown>).code
                        if (typeof inner === "string") input = inner
                      }
                    } catch {}
                    const rewritten: Record<string, unknown> = { ...record, type: "custom_tool_call", input }
                    delete rewritten.arguments
                    return rewritten
                  }
                  return entry
                })
            }
            sawTerminalEvent = true
          } else if (event.type === "response.failed" || event.type === "error") {
            sawTerminalEvent = true
          }
          push(frameEvent(event))
        }
        if (!sawTerminalEvent) {
          // 客户端主动断开（超时/取消/平台回收）时 request.signal 已中止，
          // 上游 reader.read() 抛 AbortError：静默关流，不再合成 truncated
          // 或 proxy_stream_error 误导客户端重报“会话中断”。
          if (request.signal.aborted) return
          // Upstream closed the connection without a terminal event (e.g. a
          // mid-generation EOF). Never let the stream end silently: clients
          // would treat truncated output as a complete response.
          push(frameEvent({
            type: "error",
            code: "upstream_stream_truncated",
            message: "upstream closed the stream before a terminal response event",
          }))
        }
      } catch (error) {
        // 同上：客户端取消静默关流；仅非取消异常才合成错误帧。
        if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) return
        const message = error instanceof Error ? error.message : "stream interrupted"
        push(frameEvent({ type: "error", code: "proxy_stream_error", message }))
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


