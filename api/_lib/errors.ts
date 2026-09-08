import type { ChatChunk } from "./types.js"

// ---------------------------------------------------------------------------
// OpenAI-shaped error JSON
// ---------------------------------------------------------------------------

export interface ErrorShape {
  status: number
  body: {
    error: {
      message: string
      type: string
      code: string | null
      param: null
    }
  }
}

export function jsonError(status: number, message: string, code?: string, type = "invalid_request_error"): ErrorShape {
  return {
    status,
    body: {
      error: { message, type, code: code ?? null, param: null },
    },
  }
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

// Map an upstream (opencode zen) non-2xx response onto the OpenAI error shape.
// 429 and 400 keep their status; everything else becomes 502.
export function upstreamErrorToOpenAI(status: number, upstreamBody: unknown): ErrorShape {
  const detail = extractUpstreamMessage(upstreamBody) ?? `upstream error ${status}`
  if (status === 429) return jsonError(429, detail, "upstream_rate_limited", "rate_limit_error")
  if (status === 400) return jsonError(400, detail, "upstream_bad_request")
  if (status === 401 || status === 403)
    return jsonError(502, `upstream rejected credentials (${status}): ${detail}`, "upstream_auth", "api_error")
  return jsonError(502, detail, "upstream_error", "api_error")
}

// ---------------------------------------------------------------------------
// In-stream error chunk (for errors that happen mid-SSE)
// ---------------------------------------------------------------------------

export function errorChunk(id: string, created: number, model: string, message: string): ChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { content: `[muse-proxy upstream error] ${message}` },
        finish_reason: null,
      },
    ],
  }
}
