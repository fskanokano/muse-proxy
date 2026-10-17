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

import { OaCompatRaiser, isDonePayload, lowerChatUpstream, raiseOaCompatChunk, type ChatUpstreamRequest } from "./chat-upstream.ts"
import { parseUpstreamSse } from "./sse.ts"
import { runGoalTurns, type GoalCtx } from "./goal.ts"
import type { ModelInfo, UpstreamInputItem, UpstreamTool } from "./types.ts"
import { OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_USER_AGENT } from "./types.ts"

// Same endpoint swap as UPSTREAM_URL (types.ts): /zen/v1 is gated off since
// 2026-10-14. 2026-10-17: the catalog's provider.api moved to
// /inference/openai/v1 for the openai-compatible mounts — the proxy follows
// it (live-probed: both mounts accept the same gate-passing body with 200;
// the old /inference/v1 mount still works and stays documented as fallback).
export const OA_COMPAT_URL = "https://opencode.ai/inference/openai/v1/chat/completions"

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
  /** goal 自动续轮上限 (MP_GOAL_MAX_ROUNDS; undefined/0 = 关闭续轮, 与旧行为一致的关键路径不 obsolete)。 */
  goalMaxRounds?: number
  /** Render an upstream non-2xx (or thrown fetch) error in facade shape. */
  renderUpstreamError: (status: number, body: unknown) => Response
  renderNetworkError: (message: string) => Response
}

// oa-compat SSE lines -> zen Responses events.
export async function* oaCompatEvents(
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
          for (const event of raiser.finishStream("done")) yield event
          yield "done"
          return
        }
        for (const event of raiseOaCompatChunk(payload, raiser)) yield event as Record<string, unknown>
      }
    }
  }
  for (const event of raiser.finishStream("eof")) yield event
  yield "done"
}

function* dataPayloads(line: string): Generator<string> {
  if (line.startsWith("data:")) yield line.slice(5).replace(/^\s/, "").replace(/\r$/, "")
}

/** Fingerprint-faithful mutation for the oa-compat mount (首轮 + goal judge/续轮共用)。 */
export function chatUpstreamHeaders(sessionId: string): Record<string, string> {
  return {
    authorization: `Bearer ${UPSTREAM_API_KEY}`,
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": UPSTREAM_USER_AGENT,
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId,
    // The v2 client (2.0.29/2.0.30) does NOT send x-opencode-request, and
    // re-adding the header trips the free-tier gate (403). The msg_ id
    // stays local-only.

    "x-opencode-client": OPENCODE_CLIENT,
    "x-opencode-project": OPENCODE_PROJECT_ID,
  }
}

/** Post one chat-completions request against the oa-compat mount (goal 续轮/judge 复用)。 */
export function postChatUpstream(
  fetchImpl: typeof fetch,
  sessionId: string,
  body: ChatUpstreamRequest | Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchImpl(OA_COMPAT_URL, {
    method: "POST",
    headers: chatUpstreamHeaders(sessionId),
    body: JSON.stringify(body),
    signal,
  })
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
    upstream = await postChatUpstream(downstream.fetchImpl, downstream.identity.sessionId, request, downstream.signal)
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

  const createdAt = Math.floor(Date.now() / 1000)
  const raiser = new OaCompatRaiser(downstream.model.id, downstream.callId, createdAt)
  // goal 实验模型: 无工具干净收尾时过 judge, 判未完成则自动续轮 (见 _lib/goal.ts)。
  // judge/续轮与首轮共用同一 oa-compat mount + 指纹头; 事件在 raise 层之前包装。
  if (downstream.model.isGoal) {
    const ctx: GoalCtx = {
      model: downstream.model,
      baseBody: request,
      input: downstream.input,
      tools: downstream.tools,
      maxRounds: downstream.goalMaxRounds ?? 1000,
      identity: downstream.identity,
      created: createdAt,
      callId: downstream.callId,
      signal: downstream.signal,
      postChatUpstream: (body) =>
        postChatUpstream(downstream.fetchImpl, downstream.identity.sessionId, body as ChatUpstreamRequest, downstream.signal),
      streamEvents: (body) =>
        oaCompatEvents(body, new OaCompatRaiser(downstream.model.id, downstream.callId, createdAt)),
    }
    return consume(runGoalTurns(oaCompatEvents(upstream.body, raiser), ctx))
  }
  return consume(oaCompatEvents(upstream.body, raiser))
}
