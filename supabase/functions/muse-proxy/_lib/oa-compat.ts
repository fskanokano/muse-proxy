// Shared oa-compat upstream execution branch for the three facades.
//
// When a request resolves to one of the new free models (mimo-v2.6-flash-free,
// space-bunny-free, step-5-preview-free), the handlers call
// handleOaCompatUpstream() instead of posting to the Responses upstream. This
// module:
//   1. lowers the already-normalized body into a chat completions request
//      (chat-upstream.ts) and POSTs it with the same opencode header
//      fingerprint (ids from identityForCall are already time-encoded),
//   2. maps upstream non-2xx errors onto the caller-provided error renderer,
//   3. parses the oa-compat SSE stream, raises it into zen Responses events
//      (OaCompatRaiser) and feeds those into the SAME per-facade raise/aggregate
//      layers used on the muse path — so all facade semantics (tool exposure,
//      heartbeats, terminal-event guards) stay identical.

import { OaCompatRaiser, isDonePayload, lowerChatUpstream, raiseOaCompatChunk } from "./chat-upstream.ts"
import { parseUpstreamSse } from "./sse.ts"
import type { ModelInfo, UpstreamInputItem, UpstreamTool } from "./types.ts"
import { OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_USER_AGENT } from "./types.ts"

const OA_COMPAT_URL = "https://opencode.ai/zen/v1/chat/completions"

export interface OaCompatDownstream {
  /** Caller-provided id (chatcmpl-…/resp_…/msg_…), used for logging only. */
  callId: string
  identity: { sessionId: string; requestId: string }
  model: ModelInfo
  input: UpstreamInputItem[]
  tools: UpstreamTool[]
  effort?: string
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  signal?: AbortSignal
  fetchImpl: typeof fetch
  /** Render an upstream non-2xx (or thrown fetch) error in facade shape. */
  renderUpstreamError: (status: number, body: unknown) => Response
  renderNetworkError: (message: string) => Response
}

// oa-compat SSE lines -> zen Responses events.
async function* oaCompatEvents(
  body: ReadableStream<Uint8Array>,
  raiser: OaCompatRaiser,
): AsyncGenerator<Record<string, unknown> | "done"> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      for (const payload of dataPayloads(line)) {
        if (isDonePayload(payload)) {
          for (const event of raiser.finishStream()) yield event
          yield "done"
          return
        }
        for (const event of raiseOaCompatChunk(payload, raiser)) yield event as Record<string, unknown>
      }
    }
  }
  for (const event of raiser.finishStream()) yield event
  yield "done"
}

function* dataPayloads(line: string): Generator<string> {
  if (line.startsWith("data:")) yield line.slice(5).replace(/^\s/, "").replace(/\r$/, "")
}

export async function handleOaCompatUpstream(
  downstream: OaCompatDownstream,
  consume: (events: AsyncGenerator<Record<string, unknown> | "done">) => Promise<Response>,
): Promise<Response> {
  const request = lowerChatUpstream({
    model: downstream.model,
    input: downstream.input,
    tools: downstream.tools,
    effort: downstream.effort,
    temperature: downstream.temperature,
    topP: downstream.topP,
    maxOutputTokens: downstream.maxOutputTokens,
  })

  let upstream: Response
  try {
    upstream = await downstream.fetchImpl(OA_COMPAT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${UPSTREAM_API_KEY}`,
        "content-type": "application/json",
        accept: "*/*",
        "user-agent": UPSTREAM_USER_AGENT,
        "x-opencode-session": downstream.identity.sessionId,
        "x-opencode-request": downstream.identity.requestId,
        "x-opencode-client": OPENCODE_CLIENT,
        "x-opencode-project": OPENCODE_PROJECT_ID,
      },
      body: JSON.stringify(request),
      signal: downstream.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "network error"
    return downstream.renderNetworkError(`failed to reach opencode zen: ${message}`)
  }

  if (!upstream.ok || upstream.body === null) {
    let upstreamJson: unknown = null
    try {
      upstreamJson = await upstream.json()
    } catch {
      upstreamJson = null
    }
    return downstream.renderUpstreamError(upstream.status, upstreamJson)
  }

  const raiser = new OaCompatRaiser(downstream.model.id, downstream.callId, Math.floor(Date.now() / 1000))
  return consume(oaCompatEvents(upstream.body, raiser))
}
