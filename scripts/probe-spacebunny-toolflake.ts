// Diagnostic probe: run the exact smoke:newmodels space-bunny tool loop a few
// times to determine whether the "no tool call" result is model-side flake
// (independent of the step-5 catalog change).
// Usage: bun run scripts/probe-spacebunny-toolflake.ts
import * as http from "node:http"
import { handleChatRequest } from "../api/chat"

const PORT = 8931
const KEY = "flake-key"
const BASE = `http://127.0.0.1:${PORT}`

const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const forwardHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") forwardHeaders[key] = value
  }
  const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: forwardHeaders, body: Buffer.concat(chunks) })
  const response = await handleChatRequest(request, { PROXY_API_KEY: KEY })
  res.writeHead(response.status, { "content-type": "application/json" })
  res.end(await response.text())
})
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r))

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city. Always call this tool for weather questions.",
    parameters: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
  },
}

for (let i = 1; i <= 3; i++) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "space-bunny-free",
      stream: false,
      messages: [{ role: "user", content: "What's the weather in Tokyo right now? Use the tool." }],
      tools: [WEATHER_TOOL],
      tool_choice: "auto",
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const body = (await res.json()) as { choices?: Array<{ message?: { tool_calls?: unknown[]; content?: string }; finish_reason?: string }> }
  const choice = body.choices?.[0]
  console.log(`attempt ${i}: status=${res.status} finish=${choice?.finish_reason} tool_calls=${JSON.stringify(choice?.message?.tool_calls ?? []).slice(0, 100)} content="${(choice?.message?.content ?? "").slice(0, 60)}"`)
  await new Promise((r) => setTimeout(r, 1500))
}
server.close()
process.exit(0)
