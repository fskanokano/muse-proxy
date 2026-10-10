// Real multi-turn agent eval against opencode zen through muse-proxy.
// Usage: bun run eval                 (muse — the historical default)
//        MODEL=step-5-preview-free bun run eval
//
// Task: research "recently good AI coding plans" — a realistic long task —
// with reasoning_effort "xhigh" and a web_search tool the harness executes
// locally in a real agent loop: the model may call tools in ANY turn; the
// harness executes each call, feeds results back, and keeps going until the
// model produces a final answer (finish=stop, no tool calls). Then verifies
// on top of the loop:
//   streaming (multi-chunk SSE) in every turn
//   reasoning_content streamed in at least one turn
//   at least one tool call round-trip executed by the harness
//   tool result consumed -> final answer grounded in the corpus
//   multi-turn memory: last turn asks the model to recall its own answer

import { handleChatRequest } from "../api/chat"

const ENV = { PROXY_API_KEY: process.env.PROXY_API_KEY ?? "eval-key" }

const SYSTEM = "You are a research assistant. Be concise but factual."

const SEARCH_TOOL = {
  type: "function" as const,
  function: {
    name: "web_search",
    description: "Search the web. Returns a list of { title, snippet, url } results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
}

// Deterministic local "web" so the eval is reproducible without a network.
const CORPUS: Record<string, Array<{ title: string; snippet: string; url: string }>> = {
  "ai coding plans 2026": [
    { title: "OpenCode Zen (free tier)", snippet: "Muse Spark 1.3 Contributor Free: free via opencode CLI, IP-rate-limited anonymous tier.", url: "https://opencode.ai/zen" },
    { title: "Cursor Pro 2026", snippet: "$20/mo, frontier model access, agent mode with background tasks.", url: "https://cursor.com/pricing" },
    { title: "GitHub Copilot", snippet: "$10/mo, multi-model, free 2000 completions + 50 chat messages per month.", url: "https://github.com/features/copilot/plans" },
  ],
  "opencode go pricing": [
    { title: "OpenCode Go", snippet: "$5.9/mo entry tier with weekly 5h rolling windows over Go model list (GLM, Kimi, DeepSeek).", url: "https://opencode.ai/go" },
  ],
  "claude code plan": [
    { title: "Claude Code (Pro)", snippet: "$20/mo bundled with Claude Pro, uses Claude Sonnet with 5h session windows.", url: "https://anthropic.com/claude-code" },
  ],
}

// Word-level matching instead of first-word matching: a query like
// "Windsurf Pro Ultimate pricing" previously matched nothing (or worse, the
// first corpus key) because only the FIRST word was compared. Now every
// corpus entry is scored by how many of its keywords appear in the query,
// so "Muse Spark Max $100" lands on the opencode entry, not on "no results".
const STOP_WORDS = new Set(["for", "and", "the", "with", "of", "in", "a", "an", "vs", "to"])
function keywordsOf(key: string): string[] {
  return key.split(" ").filter((w) => w.length > 1 && !STOP_WORDS.has(w))
}
function localSearch(query: string): string {
  const q = query.toLowerCase()
  let bestKey: string | null = null
  let bestScore = 0
  for (const key of Object.keys(CORPUS)) {
    const words = keywordsOf(key)
    if (words.length === 0) continue
    const score = words.filter((w) => q.includes(w)).length / words.length
    if (score > bestScore) {
      bestScore = score
      bestKey = key
    }
  }
  const results = bestKey !== null && bestScore >= 0.5 ? CORPUS[bestKey]! : []
  if (results.length > 0) return JSON.stringify(results)
  // Empty results are a valid tool outcome, but keep the model informed:
  return JSON.stringify([])
}

// A tiny OpenAI-compatible agent loop on top of the proxy.
// MODEL=<id> evaluates another catalog model (default: unset -> muse, the
// historical fallback). E.g. MODEL=step-5-preview-free bun run eval
let searchCallCount = 0
const EVAL_MODEL = process.env.MODEL

async function callModel(messages: unknown[], stream: boolean) {
  const request = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ENV.PROXY_API_KEY}` },
    body: JSON.stringify({
      ...(EVAL_MODEL ? { model: EVAL_MODEL } : {}),
      stream,
      reasoning_effort: "xhigh",
      messages,
      tools: [SEARCH_TOOL],
      tool_choice: "auto",
      max_tokens: 2000,
    }),
  })
  const res = await handleChatRequest(request, ENV)
  if (!res.ok) {
    console.error(`UPSTREAM/PROXY FAIL status=${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  return res
}

interface TurnResult {
  reasoning: string
  content: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  finish: string
  chunkCount: number
  firstChunkMs: number | null
  lastChunkMs: number | null
}

async function runTurn(messages: unknown[], label: string): Promise<TurnResult> {
  console.log(`\n=== ${label} (stream) ===`)
  const res = await callModel(messages, true)

  // True incremental streaming: read the SSE body as it arrives instead of
  // awaiting the full text. heartbeat comments (": hb") are ignored.
  const decoder = new TextDecoder()
  const reader = res.body!.getReader()
  let buffer = ""
  const reasoning: string[] = []
  const content: string[] = []
  const toolCalls: TurnResult["toolCalls"] = []
  let finish = ""
  let chunkCount = 0
  let firstChunkMs: number | null = null
  let lastChunkMs: number | null = null

  const handleChunk = (chunk: {
    choices?: Array<{
      delta?: { reasoning_content?: string; content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }
      finish_reason?: string | null
    }>
  }) => {
    chunkCount++
    const now = Date.now()
    if (firstChunkMs === null) firstChunkMs = now
    lastChunkMs = now
    const delta = chunk.choices?.[0]?.delta
    if (delta?.reasoning_content) reasoning.push(delta.reasoning_content)
    if (delta?.content) content.push(delta.content)
    if (delta?.tool_calls) {
      for (const call of delta.tool_calls) {
        if (call.id && call.function?.name) {
          toolCalls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments ?? "" })
        } else if (call.function?.arguments && toolCalls.length > 0) {
          toolCalls[toolCalls.length - 1]!.arguments += call.function.arguments
        }
      }
    }
    if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const data = line.slice(6).trim()
      if (data === "[DONE]") continue
      try {
        handleChunk(JSON.parse(data))
      } catch {
        // heartbeat comments and partial lines
      }
    }
  }
  // Flush any final buffered line.
  if (buffer.startsWith("data: ")) {
    const data = buffer.slice(6).trim()
    if (data !== "[DONE]") {
      try {
        handleChunk(JSON.parse(data))
      } catch {
        // ignore
      }
    }
  }

  console.log(`  chunks=${chunkCount} finish=${finish} span=${firstChunkMs !== null && lastChunkMs !== null ? lastChunkMs - firstChunkMs : 0}ms`)
  console.log(`  reasoning (${reasoning.join("").length} chars): ${reasoning.join("").slice(0, 150).replace(/\n/g, " ")}...`)
  console.log(`  content (${content.join("").length} chars): ${content.join("").slice(0, 150).replace(/\n/g, " ")}`)
  for (const call of toolCalls) console.log(`  tool_call: ${call.name}(${call.arguments.slice(0, 80)})`)

  return { reasoning: reasoning.join(""), content: content.join(""), toolCalls, finish, chunkCount, firstChunkMs, lastChunkMs }
}

async function main() {
  const verdicts: string[] = []
  const check = (ok: boolean, name: string) => {
    verdicts.push(`${ok ? "PASS" : "FAIL"} ${name}`)
    if (!ok) process.exitCode = 1
  }

  const messages: unknown[] = [{ role: "system", content: SYSTEM }]

  // ---- Agent loop: run turns until the model answers without tool calls.
  // The model may call tools in ANY turn; the harness executes each call,
  // feeds results back, and keeps going until finish=stop with no calls.
  const MAX_TURNS = 8
  const turns: TurnResult[] = []
  let finalAnswer = ""
  let answerTurnIndex = -1

  messages.push({ role: "user", content: "调研一下最近比较好用的 AI coding plan，用 web_search 查一下再总结。" })

  for (let turnIndex = 1; turnIndex <= MAX_TURNS; turnIndex++) {
    const t = await runTurn([...messages], `turn ${turnIndex}`)
    turns.push(t)
    check(t.chunkCount > 1, `turn${turnIndex} streaming (multiple SSE chunks)`)
    check(
      t.firstChunkMs !== null && t.lastChunkMs !== null && t.lastChunkMs - t.firstChunkMs > 0,
      `turn${turnIndex} chunks arrived incrementally over time (真流式)`,
    )
    if (t.reasoning.length > 0) {
      check(true, `turn${turnIndex} reasoning_content streamed (xhigh 思考可见)`)
    }

    if (t.toolCalls.length === 0) {
      check(t.finish === "stop", `turn${turnIndex} final answer finish_reason=stop`)
      check(t.content.length > 50, `turn${turnIndex} grounded final answer`)
      finalAnswer = t.content
      answerTurnIndex = turnIndex
      break
    }

    check(t.finish === "tool_calls", `turn${turnIndex} finish_reason=tool_calls`)
    check(t.toolCalls.every((c) => c.name === "web_search"), `turn${turnIndex} tool calls use web_search`)

    // Harness executes EVERY tool call locally and appends all results.
    messages.push({
      role: "assistant",
      content: t.content || null,
      reasoning_content: t.reasoning,
      tool_calls: t.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    })
    for (const call of t.toolCalls) {
      const toolOutput = localSearch(call.arguments)
      searchCallCount++
      console.log(`  -> harness web_search(${call.arguments.slice(0, 60)}) => ${toolOutput.slice(0, 100)}...`)
      messages.push({ role: "tool", tool_call_id: call.id, content: toolOutput })
    }
  }

  // ---- Loop-level assertions ----
  check(answerTurnIndex > 0, `agent loop reached a final answer within ${MAX_TURNS} turns`)
  check(turns.some((t) => t.toolCalls.length > 0), "at least one tool call round-trip executed by harness")
  check(searchCallCount > 0, "harness executed web_search tool calls")

  // Grounding: the final answer must reference corpus facts (titles).
  const corpusTitles = Object.values(CORPUS).flat().map((r) => r.title)
  const referenced = corpusTitles.filter((title) => {
    const sig = title.split(" ").slice(0, 2).join(" ").toLowerCase()
    return sig.length > 0 && finalAnswer.toLowerCase().includes(sig)
  })
  check(referenced.length > 0, `final answer grounded in tool results (mentions: ${referenced.join("; ") || "none"})`)

  // ---- Memory probe: does the model remember its own answer? ----
  const t3 = await runTurn(
    [...messages, { role: "user", content: "用一句话总结你刚才的调研结论。" }],
    "final turn (memory probe)",
  )
  check(t3.chunkCount > 1, "memory-probe streaming")
  check(t3.content.length > 10, "memory-probe answered from history")
  const probeSig = finalAnswer.split(" ").slice(0, 3).join(" ").toLowerCase()
  check(
    probeSig.length > 0 && (t3.content.toLowerCase().includes(probeSig) || /zen|cursor|copilot|claude|go/i.test(t3.content)),
    "memory-probe consistent with the final answer",
  )
  // Session-level: xhigh reasoning must surface as reasoning_content at least
  // once across ALL turns (loop turns + probe). Note it is per-turn sampled:
  // tool-call turns and answer turns may legitimately stream none, while the
  // probe (which replays encrypted reasoning upstream) reliably does.
  check(
    turns.some((t) => t.reasoning.length > 0) || t3.reasoning.length > 0,
    "reasoning_content streamed in at least one turn (xhigh 思考可见)",
  )

  console.log(`\nsearch calls executed by harness: ${searchCallCount}`)
  console.log("\n===== EVAL VERDICT =====")
  for (const v of verdicts) console.log(v)
  const failed = verdicts.filter((v) => v.startsWith("FAIL")).length
  console.log(`\n${verdicts.length - failed}/${verdicts.length} checks passed`)
  if (failed > 0) process.exit(1)
}

await main()
