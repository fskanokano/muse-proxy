// Real multi-turn CONVERSATION test — prints the actual transcripts.
//
//   bun run smoke:converse                  # all models, chat + responses
//   bun run smoke:converse -- --model=mimo  # one model
//
// The other smokes assert CONTRACTS (field shapes, terminal frames, tool
// round-trips). This one asserts CONVERSATION: each turn must depend on the
// turns before it, so a model that is merely echoing or leaking context fails.
// It prints every turn verbatim so the output can be read, not just counted.
//
// Runs against the served edge function (see EDGE_BASE_URL), i.e. the bundled
// artifact behind the gateway, with real traffic to opencode zen.

const BASE = (process.env.EDGE_BASE_URL ?? "http://127.0.0.1:8788/functions/v1/muse-proxy/v1").replace(/\/+$/, "")
const KEY = process.env.PROXY_API_KEY ?? ""
const MODELS = ["muse-spark-1.3-contributor-free", "mimo-v2.6-flash-free", "space-bunny-free"]

const args = new Map<string, string>(
  process.argv.slice(2).map((raw): [string, string] => {
    const [key = "", value = "all"] = raw.replace(/^--/, "").split("=")
    return [key, value]
  }),
)
const models = (args.get("model") ?? "all") === "all"
  ? MODELS
  : MODELS.filter((m) => m.includes(args.get("model")!))

let passed = 0
const failures: string[] = []

function check(condition: boolean, name: string, detail = ""): void {
  if (condition) {
    passed++
    console.log(`      PASS ${name}${detail ? ` — ${detail}` : ""}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
    console.log(`      FAIL ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

async function post(path: string, body: unknown, auth: Record<string, string>): Promise<Response> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (res.status !== 429 || attempt === 4) return res
    await res.text()
    await new Promise((r) => setTimeout(r, 4000 * attempt))
  }
  throw new Error("unreachable")
}

/** Chat facade: keep history in `messages` the way a real client does. */
async function chatTurn(model: string, history: Array<{ role: string; content: string }>, prompt: string): Promise<string> {
  history.push({ role: "user", content: prompt })
  const res = await post(
    "/chat/completions",
    { model, stream: false, messages: history },
    { authorization: `Bearer ${KEY}` },
  )
  if (res.status !== 200) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = body.choices?.[0]?.message?.content ?? ""
  history.push({ role: "assistant", content })
  return content
}

/** Responses facade: keep history in `input` as typed message items. */
async function responsesTurn(model: string, history: Array<Record<string, unknown>>, prompt: string): Promise<string> {
  history.push({ role: "user", content: prompt })
  const res = await post(
    "/responses",
    { model, stream: false, input: history },
    { authorization: `Bearer ${KEY}` },
  )
  if (res.status !== 200) throw new Error(`responses ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { output_text?: string }
  const content = body.output_text ?? ""
  history.push({ role: "assistant", content })
  return content
}

/** Messages facade: keep history in `messages` and authenticate per Anthropic. */
async function messagesTurn(model: string, history: Array<{ role: string; content: string }>, prompt: string): Promise<string> {
  history.push({ role: "user", content: prompt })
  const res = await post(
    "/messages",
    { model, max_tokens: 1024, stream: false, messages: history },
    { "x-api-key": KEY },
  )
  if (res.status !== 200) throw new Error(`messages ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
  const content = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
  history.push({ role: "assistant", content })
  return content
}

const trim = (text: string) => (text.length > 220 ? `${text.slice(0, 220)}…` : text).replace(/\s+/g, " ")

async function conversation(label: string, turn: (m: string, h: never[], p: string) => Promise<string>, model: string) {
  console.log(`\n  ── ${model} / ${label} ──`)
  const history = [] as never[]
  try {
    const t1 = await turn(model, history, "My name is Ada and I am a mathematician. Reply with exactly the word ACK and nothing else.")
    console.log(`      U1: My name is Ada and I am a mathematician. Reply with exactly ACK.`)
    console.log(`      A1: ${trim(t1)}`)
    check(t1.trim().length > 0, "turn 1 answered")

    const t2 = await turn(model, history, "What subject do I work in? Answer with one word.")
    console.log(`      U2: What subject do I work in?`)
    console.log(`      A2: ${trim(t2)}`)
    check(/math/i.test(t2), "turn 2 recalls the subject from turn 1", trim(t2))

    const t3 = await turn(model, history, "In one short sentence: what is my name and what do I do?")
    console.log(`      U3: In one short sentence: what is my name and what do I do?`)
    console.log(`      A3: ${trim(t3)}`)
    check(/ada/i.test(t3), "turn 3 recalls the name from turn 1", trim(t3))
    check(/math/i.test(t3), "turn 3 still recalls the subject", trim(t3))

    // Long-range recall of the very first instruction. Deliberately NOT "how
    // many turns have we had": that wording is ambiguous (a model may count
    // messages rather than user turns, which tests the model's arithmetic
    // interpretation rather than the proxy's history fidelity).
    const t4 = await turn(model, history, "What exact word did I ask you to reply with in my first message? Reply with that word only.")
    console.log(`      U4: What exact word did I ask you to reply with in my first message?`)
    console.log(`      A4: ${trim(t4)}`)
    check(/\back\b/i.test(t4), "turn 4 recalls turn 1's instruction verbatim", trim(t4))
  } catch (error) {
    check(false, `${label} conversation crashed`, error instanceof Error ? error.message : String(error))
  }
}

async function main(): Promise<void> {
  if (!KEY) {
    console.error("PROXY_API_KEY is empty")
    process.exit(1)
  }
  console.log(`\n=== MULTI-TURN CONVERSATION (${BASE}) ===`)
  for (const model of models) {
    console.log(`\n=== ${model} ===`)
    await conversation("chat completions", chatTurn as never, model)
    await conversation("responses", responsesTurn as never, model)
    await conversation("messages (anthropic)", messagesTurn as never, model)
  }
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`)
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
  }
  console.log("CONVERSATION OK")
  process.exit(0)
}

await main()

export {}