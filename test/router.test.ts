import { describe, expect, it } from "vitest"
import { handleRequest, matchRoute, normalizePath } from "../supabase/functions/v1/router.ts"

const ENV = { PROXY_API_KEY: "test-key" }
const AUTH = { authorization: "Bearer test-key" }

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const lines = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  return new Response(lines + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

// A fetch stub that mints a fresh (unlocked) SSE body per call.
function fetchStubFactory(events: Array<Record<string, unknown>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return sseResponse(events)
  }) as typeof fetch
  return { calls, fetchImpl }
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://project-ref.supabase.co${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: "{}",
    ...init,
  })
}

describe("edge function path normalization", () => {
  it("matches every mount form Supabase can hand the function", () => {
    // The hosted gateway sends the full path; a bare function serve sends only
    // the sub-path. Both must resolve to the same facade.
    for (const prefix of ["", "/v1", "/functions/v1", "/functions/v1/v1"]) {
      expect(matchRoute(`${prefix}/chat/completions`)).toBe("chat")
      expect(matchRoute(`${prefix}/responses`)).toBe("responses")
      expect(matchRoute(`${prefix}/messages`)).toBe("messages")
      expect(matchRoute(`${prefix}/models`)).toBe("models")
    }
  })

  it("tolerates a trailing slash", () => {
    expect(matchRoute("/functions/v1/v1/responses/")).toBe("responses")
    expect(normalizePath("/functions/v1/v1/")).toBe("/")
  })

  it("does not double-prefix: /v1/v1 is stripped only once", () => {
    expect(normalizePath("/functions/v1/v1/chat/completions")).toBe("/chat/completions")
    expect(normalizePath("/v1/chat/completions")).toBe("/chat/completions")
  })

  it("returns null for unknown paths", () => {
    expect(matchRoute("/functions/v1/v1/embeddings")).toBeNull()
    expect(matchRoute("/functions/v1/v1/chat")).toBeNull()
    expect(matchRoute("/")).toBeNull()
  })

  it("prefers the longest mount prefix", () => {
    // /functions/v1/v1/models belongs to this function, not a hypothetical
    // sibling function mounted at /functions/v1.
    expect(normalizePath("/functions/v1/v1/models")).toBe("/models")
    expect(normalizePath("/functions/v1/models")).toBe("/models")
  })
})

describe("edge function dispatch", () => {
  it("routes /chat/completions to the chat facade", async () => {
    const { calls, fetchImpl } = fetchStubFactory([
      { type: "response.output_text.delta", delta: "pong" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ])
    const res = await handleRequest(
      request("/functions/v1/v1/chat/completions", { body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }),
      ENV,
      { fetchImpl },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { object: string; choices: Array<{ message: { content: string } }> }
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0]!.message.content).toBe("pong")
    expect(calls[0]!.url).toBe("https://opencode.ai/zen/v1/responses")
  })

  it("routes /responses to the responses facade", async () => {
    const { fetchImpl } = fetchStubFactory([
      { type: "response.output_text.delta", delta: "pong" },
      {
        type: "response.output_item.done",
        item: { type: "message", content: [{ type: "output_text", text: "pong" }] },
      },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ])
    const res = await handleRequest(
      request("/functions/v1/v1/responses", { body: JSON.stringify({ input: "hi" }) }),
      ENV,
      { fetchImpl },
    )
    const body = (await res.json()) as { object: string; output_text: string }
    expect(body.object).toBe("response")
    expect(body.output_text).toBe("pong")
  })

  it("routes /messages to the messages facade and uses the Anthropic envelope", async () => {
    const { fetchImpl } = fetchStubFactory([
      { type: "response.output_text.delta", delta: "pong" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ])
    const res = await handleRequest(
      request("/functions/v1/v1/messages", {
        headers: { "content-type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({ max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
      }),
      ENV,
      { fetchImpl },
    )
    const body = (await res.json()) as { type: string; content: Array<{ text: string }> }
    expect(body.type).toBe("message")
    expect(body.content[0]!.text).toBe("pong")
  })

  it("serves /v1/models without touching the upstream", async () => {
    const { calls, fetchImpl } = fetchStubFactory([])
    const res = await handleRequest(
      new Request("https://project-ref.supabase.co/functions/v1/v1/models", { headers: AUTH }),
      ENV,
      { fetchImpl },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> }
    expect(body.object).toBe("list")
    expect(body.data.map((model) => model.id)).toEqual([
      "muse-spark-1.3-contributor-free",
      "mimo-v2.6-flash-free",
      "space-bunny-free",
    ])
    expect(calls).toHaveLength(0)
  })

  it("404s an unknown route without calling the upstream", async () => {
    const { calls, fetchImpl } = fetchStubFactory([])
    const res = await handleRequest(request("/functions/v1/v1/embeddings"), ENV, { fetchImpl })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; type: string } }
    expect(body.error.code).toBe("not_found")
    expect(body.error.type).toBe("invalid_request_error")
    expect(calls).toHaveLength(0)
  })

  it("serves an index at the function root", async () => {
    const res = await handleRequest(new Request("https://project-ref.supabase.co/functions/v1/v1", { headers: AUTH }), ENV)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { function: string; endpoints: string[] }
    expect(body.function).toBe("v1")
    expect(body.endpoints).toContain("GET /v1/models")
  })

  it("fails closed when PROXY_API_KEY is not configured", async () => {
    const { calls, fetchImpl } = fetchStubFactory([])
    for (const path of ["/chat/completions", "/responses", "/messages", "/models"]) {
      const res = await handleRequest(request(`/functions/v1/v1${path}`), {}, { fetchImpl })
      expect(res.status).toBe(401)
    }
    expect(calls).toHaveLength(0)
  })

  it("forwards the injected fetch seam to the facades", async () => {
    // A router that dropped the dependency would silently hit the real upstream;
    // assert the seam is threaded through instead.
    const { calls, fetchImpl } = fetchStubFactory([{ type: "response.completed", response: {} }])
    await handleRequest(
      request("/functions/v1/v1/chat/completions", { body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }),
      ENV,
      { fetchImpl },
    )
    expect(calls).toHaveLength(1)
    const init = calls[0]!.init!
    // The opencode free-tier fingerprint must survive the migration untouched.
    const headers = init.headers as Record<string, string>
    expect(headers["user-agent"]).toBe("opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14")
    expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(headers.authorization).toBe("Bearer public")
  })

  it("rejects GET on POST-only facades but allows it on /v1/models", async () => {
    for (const path of ["/chat/completions", "/responses", "/messages"]) {
      const res = await handleRequest(
        new Request(`https://project-ref.supabase.co/functions/v1/v1${path}`, { headers: AUTH }),
        ENV,
      )
      expect(res.status).toBe(405)
    }
    const models = await handleRequest(
      new Request("https://project-ref.supabase.co/functions/v1/v1/models", { headers: AUTH }),
      ENV,
    )
    expect(models.status).toBe(200)
  })
})

