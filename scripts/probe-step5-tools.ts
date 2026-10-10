// Diagnostic probe (not part of the test suite): step-5-preview-free tool
// calling over the REAL zen oa-compat edge through the project's own
// chat-upstream converter — single call, parallel-call replay merge, and
// multi-turn tool result loop.
// Usage: bun run scripts/probe-step5-tools.ts
import { lowerChatUpstream, lowerInputToMessages } from "../api/_lib/chat-upstream"
import { identityForCall } from "../api/_lib/identity"
import { OPENCODE_CLIENT, OPENCODE_PROJECT_ID, UPSTREAM_API_KEY, UPSTREAM_USER_AGENT, type ModelInfo, type UpstreamInputItem, type UpstreamTool } from "../api/_lib/types"
import { OaCompatRaiser, raiseOaCompatChunk, isDonePayload } from "../api/_lib/chat-upstream"

const OA_COMPAT_URL = "https://opencode.ai/zen/v1/chat/completions"
const STEP5_INFO: ModelInfo = {
  id: "step-5-preview-free",
  name: "Step 5 Preview Free",
  upstream: "oa-compat",
  description: "probe",
  contextWindow: 1_000_000,
  maxOutputTokens: 32_000,
  efforts: [],
}

const weatherTool: UpstreamTool = {
  type: "function",
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
  strict: false,
}

async function chat(body: unknown, identity: { sessionId: string; requestId: string }) {
  const res = await fetch(OA_COMPAT_URL, {
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
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return res
}

interface Raised { events: Array<Record<string, unknown>> }

async function raiseStream(res: Response): Promise<Raised> {
  const raiser = new OaCompatRaiser("step-5-preview-free", `resp_${Math.random().toString(36).slice(2)}`, Math.floor(Date.now() / 1000))
  const events: Array<Record<string, unknown>> = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim()
        if (isDonePayload(payload)) {
          events.push(...raiser.finishStream())
          return { events }
        }
        events.push(...raiseOaCompatChunk(payload, raiser))
      }
    }
  }
  events.push(...raiser.finishStream())
  return { events }
}

function summarize(events: Array<Record<string, unknown>>) {
  let text = ""
  let reasoning = 0
  const calls: Array<{ name: string; arguments: string }> = []
  for (const e of events) {
    if (e.type === "response.output_text.delta") text += e.delta
    if (e.type === "response.reasoning_text.delta") reasoning += (e.delta as string).length
    if (e.type === "response.output_item.done" && (e.item as Record<string, unknown>)?.type === "function_call") {
      const item = e.item as Record<string, unknown>
      calls.push({ name: item.name as string, arguments: item.arguments as string })
    }
  }
  const completed = events.find((e) => e.type === "response.completed") as { response?: { usage?: unknown } } | undefined
  return { text, reasoning, calls, usage: completed?.response?.usage }
}

// --- Test 1: single tool call -------------------------------------------
let identity = identityForCall("probe-step5-tool-single")
const body1 = lowerChatUpstream({
  model: STEP5_INFO,
  input: [{ role: "user", content: [{ type: "input_text", text: "What is the weather in Paris? Use the get_weather tool." }] }],
  tools: [weatherTool],
  maxOutputTokens: 2048,
})
console.log("T1 request:", JSON.stringify(body1).slice(0, 400))
const res1 = await chat(body1, identity)
console.log("T1 status:", res1.status)
const raised1 = await raiseStream(res1)
console.log("T1 summary:", JSON.stringify(summarize(raised1.events)))

// --- Test 2: parallel tool calls replay (two function_call in one assistant message) ---
const parallelInstructions: UpstreamInputItem[] = [
  { role: "user", content: [{ type: "input_text", text: "Get weather for Paris and Berlin in parallel. Call get_weather twice." }] },
]
const body2 = lowerChatUpstream({
  model: STEP5_INFO,
  input: parallelInstructions,
  tools: [weatherTool],
  maxOutputTokens: 2048,
})
identity = identityForCall("probe-step5-tool-parallel")
const res2 = await chat(body2, identity)
console.log("T2 status:", res2.status)
const raised2 = await raiseStream(res2)
console.log("T2 summary:", JSON.stringify(summarize(raised2.events)))

// --- Test 3: multi-turn tool result loop ---------------------------------
if (raised1.events.length > 0) {
  const s1 = summarize(raised1.events)
  if (s1.calls.length > 0) {
    const call = s1.calls[0]!
    const loopInput: UpstreamInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: "What is the weather in Paris? Use the get_weather tool." }] },
      { type: "function_call", call_id: `call_${Math.random().toString(36).slice(2, 10)}`, name: call.name, arguments: call.arguments },
      { type: "function_call_output", call_id: `call_${Math.random().toString(36).slice(2, 10)}`, output: "18C, sunny" },
    ]
    const messages = lowerInputToMessages(loopInput)
    console.log("T3 lowered messages:", JSON.stringify(messages).slice(0, 300))
    const body3 = lowerChatUpstream({
      model: STEP5_INFO,
      input: loopInput,
      tools: [weatherTool],
      maxOutputTokens: 2048,
    })
    identity = identityForCall("probe-step5-tool-loop")
    const res3 = await chat(body3, identity)
    console.log("T3 status:", res3.status)
    if (res3.ok) {
      const raised3 = await raiseStream(res3)
      console.log("T3 summary:", JSON.stringify(summarize(raised3.events)))
    } else {
      console.log("T3 error:", (await res3.text()).slice(0, 300))
    }
  }
}
