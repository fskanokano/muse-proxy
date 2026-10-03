// Sandbox end-to-end tests over the real HTTP stack: a local mock upstream
// server + a local proxy server dispatching to all three facades. Verifies
// wire behavior (SSE framing, headers, status codes) for /v1/responses and
// /v1/messages, and proves /v1/chat/completions keeps working untouched
// alongside them on the same server.

import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleChatRequest } from "../api/chat"
import { handleResponsesRequest } from "../api/responses"
import { handleMessagesRequest } from "../api/messages"
import { OPENCODE_BUILTIN_TOOLS } from "../supabase/functions/v1/_lib/tools.ts"

const ENV = { PROXY_API_KEY: "e2e-key" }

interface CapturedRequest {
  headers: http.IncomingHttpHeaders
  body: string
}

function startMockUpstream(events: Array<Record<string, unknown>>, captured: CapturedRequest[]): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        captured.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") })
        res.writeHead(200, { "content-type": "text/event-stream" })
        let index = 0
        const writeNext = () => {
          if (index >= events.length) {
            res.end()
            return
          }
          res.write(`data: ${JSON.stringify(events[index]!)}\n\n`)
          index++
          setTimeout(writeNext, 5)
        }
        writeNext()
      })
    })
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

function startProxyServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const url = `http://127.0.0.1${req.url}`
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === "POST" || req.method === "PUT" ? Buffer.concat(chunks) : undefined,
      })
      const response = req.url === "/v1/responses"
        ? await handleResponsesRequest(request, ENV)
        : req.url === "/v1/messages"
          ? await handleMessagesRequest(request, ENV)
          : await handleChatRequest(request, ENV)
      const headerEntries: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headerEntries[key] = value
      })
      res.writeHead(response.status, headerEntries)
      if (response.body) {
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      }
      res.end()
    })
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

describe("sandbox e2e over real HTTP", () => {
  let upstreamServer: http.Server
  let proxyServer: http.Server
  let captured: CapturedRequest[]
  let originalFetch: typeof globalThis.fetch
  let upstreamBase: string

  beforeEach(async () => {
    captured = []
    originalFetch = globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await new Promise<void>((resolve) => upstreamServer?.close(() => resolve()))
    await new Promise<void>((resolve) => proxyServer?.close(() => resolve()))
  })

  async function boot(events: Array<Record<string, unknown>>) {
    upstreamServer = await startMockUpstream(events, captured)
    const upstreamPort = (upstreamServer.address() as AddressInfo).port
    upstreamBase = `http://127.0.0.1:${upstreamPort}`
    // Route only the handlers' upstream fetches (opencode.ai) to the local
    // mock server over a real socket; every other hop stays genuine HTTP.
    // Capture the native fetch BEFORE replacing globalThis.fetch, or the
    // wrapper would recurse.
    const realFetch = globalThis.fetch
    globalThis.fetch = ((url: unknown, init?: RequestInit) => {
      const target = typeof url === "string" ? new URL(url) : (url as URL)
      if (target.host === "opencode.ai") {
        return realFetch(`${upstreamBase}${target.pathname}`, init)
      }
      return realFetch(url as string, init)
    }) as typeof fetch
    proxyServer = await startProxyServer()
    const proxyPort = (proxyServer.address() as AddressInfo).port
    return `http://127.0.0.1:${proxyPort}`
  }

  it("POST /v1/responses non-streaming returns an aggregated response object", async () => {
    const base = await boot([
      { type: "response.created", response: { id: "resp_e2e_1" } },
      { type: "response.output_text.delta", delta: "e2e " },
      { type: "response.output_text.delta", delta: "hello" },
      {
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "e2e hello" }] },
      },
      { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } },
    ])

    const res = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer e2e-key" },
      body: JSON.stringify({ model: "anything", input: "say hi", stream: false }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.object).toBe("response")
    expect(body.id).toBe("resp_e2e_1")
    expect(body.status).toBe("completed")
    expect(body.output_text).toBe("e2e hello")
    expect(body.usage).toEqual({ input_tokens: 4, output_tokens: 2, total_tokens: 6 })

    // The opencode fingerprint must survive the real HTTP hop.
    const upstreamHeaders = captured[0]!.headers
    expect(upstreamHeaders["user-agent"]).toContain("opencode/")
    expect(upstreamHeaders["x-opencode-client"]).toBe("cli")
    expect(String(upstreamHeaders["x-opencode-session"])).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    const upstreamBody = JSON.parse(captured[0]!.body) as Record<string, unknown>
    expect(upstreamBody.store).toBe(false)
    expect((upstreamBody.tools as unknown[]).length).toBe(OPENCODE_BUILTIN_TOOLS.length)
  })

  it("POST /v1/responses streaming emits canonical event:/data: SSE frames over the wire", async () => {
    const base = await boot([
      { type: "response.created", response: { id: "resp_e2e_s" } },
      { type: "response.output_text.delta", delta: "st" },
      // Upstream keep-alive frames (sent by real opencode zen) must not leak.
      { type: "ping" },
      { type: "response.output_text.delta", delta: "ream" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ])

    const res = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer e2e-key" },
      body: JSON.stringify({ input: "hi", stream: true }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()

    expect(text).not.toContain("[DONE]")
    expect(text).not.toContain("event: ping")
    const frames = text.split("\n\n").filter((block) => block.startsWith("event: "))
    expect(frames.map((f) => f.split("\n")[0]!.slice(7))).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.completed",
    ])
    const deltas = frames
      .filter((f) => f.includes("output_text.delta"))
      .map((f) => (JSON.parse(f.split("\n")[1]!.slice(6)) as { delta: string }).delta)
    expect(deltas.join("")).toBe("stream")
  })

  it("regression: POST /v1/chat/completions keeps working unchanged on the same server", async () => {
    const base = await boot([
      { type: "response.output_text.delta", delta: "chat " },
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ])

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer e2e-key" },
      body: JSON.stringify({ model: "anything", stream: true, messages: [{ role: "user", content: "ping" }] }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()

    // Chat facade contract intact: chat.completion.chunk frames + [DONE].
    expect(text).toContain('"object":"chat.completion.chunk"')
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
    const content = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map((line) => (JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content)
      .filter(Boolean)
      .join("")
    expect(content).toBe("chat ok")

    // The chat facade's upstream contract is untouched as well.
    const upstreamBody = JSON.parse(captured[0]!.body) as Record<string, unknown>
    expect(upstreamBody.store).toBe(false)
    expect((upstreamBody.tools as unknown[]).length).toBe(OPENCODE_BUILTIN_TOOLS.length)
  })

  it("POST /v1/messages non-streaming returns an aggregated Anthropic message over the wire", async () => {
    const base = await boot([
      { type: "response.created", response: { id: "resp_e2e_m", usage: null } },
      { type: "response.output_text.delta", delta: "e2e " },
      { type: "response.output_text.delta", delta: "anthropic" },
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
    ])

    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "e2e-key" },
      body: JSON.stringify({
        model: "claude-anything",
        max_tokens: 128,
        messages: [{ role: "user", content: "say hi" }],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.stop_reason).toBe("end_turn")
    expect(body.content).toEqual([{ type: "text", text: "e2e anthropic" }])
    expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 2 })

    // Same free-tier fingerprint contract as the other facades.
    const upstreamBody = JSON.parse(captured[0]!.body) as Record<string, unknown>
    expect(upstreamBody.store).toBe(false)
    expect((upstreamBody.tools as unknown[]).length).toBe(OPENCODE_BUILTIN_TOOLS.length)
    expect(captured[0]!.headers["user-agent"]).toContain("opencode/")
  })

  it("POST /v1/messages streaming emits canonical Anthropic SSE frames over the wire", async () => {
    const base = await boot([
      { type: "response.created", response: { id: "resp_e2e_ms" } },
      { type: "response.output_text.delta", delta: "he" },
      { type: "ping" },
      { type: "response.output_text.delta", delta: "y" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ])

    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "e2e-key" },
      body: JSON.stringify({ max_tokens: 64, messages: [{ role: "user", content: "hi" }], stream: true }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()

    expect(text).not.toContain("[DONE]")
    expect(text).not.toContain("event: ping")
    const frames = text.split("\n\n").filter((block) => block.startsWith("event: "))
    expect(frames.map((f) => f.split("\n")[0]!.slice(7))).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    const deltas = frames
      .filter((f) => f.includes('"type":"content_block_delta"'))
      .map((f) => (JSON.parse(f.split("\n")[1]!.slice(6)) as { delta: { text: string } }).delta.text)
    expect(deltas.join("")).toBe("hey")
  })

  it("regression: all three facades respond on the same proxy server", async () => {
    const base = await boot([
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ])

    const routes: Array<{ path: string; body: Record<string, unknown>; auth: Record<string, string> }> = [
      { path: "/v1/chat/completions", body: { model: "x", messages: [{ role: "user", content: "hi" }] }, auth: { authorization: "Bearer e2e-key" } },
      { path: "/v1/responses", body: { input: "hi" }, auth: { authorization: "Bearer e2e-key" } },
      { path: "/v1/messages", body: { max_tokens: 8, messages: [{ role: "user", content: "hi" }] }, auth: { "x-api-key": "e2e-key" } },
    ]
    for (const route of routes) {
      const res = await fetch(`${base}${route.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...route.auth },
        body: JSON.stringify({ ...route.body, stream: false }),
      })
      expect(res.status, route.path).toBe(200)
    }
  })

  it("auth failure on /v1/responses returns 401 through the wire", async () => {
    const base = await boot([{ type: "response.completed", response: {} }])
    const res = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ input: "hi" }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("authentication_error")
  })
})
