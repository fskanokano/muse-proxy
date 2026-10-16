// Wire types for the OpenAI Chat Completions facade and the opencode zen
// Responses API upstream. Zero runtime dependencies.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Endpoint moved 2026-10-14: the legacy /zen/v1 path now answers every
// inference call with 403 FreeTierError; the live client (2.0.29) reads
// https://opencode.ai/inference/v1 from the runtime catalog
// (models.opencode.ai/api.json -> providers.opencode.api) and posts there.
// The model->format routing is unchanged: muse keeps /responses, the
// oa-compat models keep /chat/completions (re-probed both ways).
export const UPSTREAM_URL = "https://opencode.ai/inference/v1/responses"
// opencode zen free models accept the literal api key "public" when no zen
// account key is configured (see opencode provider.ts custom loader).
export const UPSTREAM_API_KEY = "public"
// The anonymous free tier is gated on an opencode-client fingerprint:
// request headers (UA + x-opencode-* ids) AND the body's tools array (must
// carry the opencode builtin tool names, see _lib/tools.ts). Recent zen
// releases tightened this fingerprint; non-matching traffic gets
// "OpenCode's free tier can only be used from within OpenCode" (the gate
// lives in the closed-source edge; the open-source repo only tells us what
// a real client sends). Since 2026-10-14 the gate also reads the request
// body's tools array CONTENT (descriptions + parameter schemas), so the
// builtin definitions in _lib/tools.ts ship verbatim.
//
// UA mirrors what the shipped opencode CLI emits on the wire. The v2 client
// (`@opencode/cli`, repo github.com/anomalyco/opencode — the repo the README
// clones) builds it as `opencode/<channel>/<version>/<name>`, captured
// 2026-10-14 as `opencode/latest/2.0.29/cli`. The legacy v1 `opencode-ai`
// binary emitted `opencode/<version> ai-sdk/provider-utils/<v> runtime/bun/<v>`
// instead; both pass the gate today, but the proxy mirrors the current
// client. Re-verify on every upstream version bump (`npm view @opencode/cli
// version`; the channel is "latest" for any non-snapshot release).
//
// 2026-10-16 re-verification after re-cloning the upstream repo (dev tip
// e25b7ab, packages/cli/package.json 2.0.30): the UA builder is unchanged
// (`packages/core/src/app.ts` `useragent()` == `opencode/${channel}/${version}/${name}`)
// and the request headers moved to `packages/core/src/session/model-request.ts`
// with the same four session aliases the proxy already sends (session /
// session-id / affinity / x-session-id) and still NO `x-opencode-request`.
// Live-probed both versions against /inference/v1: 2.0.29 and 2.0.30 both 200,
// so the constant simply follows npm latest.
export const OPENCODE_VERSION = "2.0.30"
export const OPENCODE_CHANNEL = "latest"
export const OPENCODE_CLIENT = "cli"
export const UPSTREAM_USER_AGENT = `opencode/${OPENCODE_CHANNEL}/${OPENCODE_VERSION}/${OPENCODE_CLIENT}`
// The CLI sends x-opencode-project: "global" (project id of a global home
// session); the edge accepts any value, but match the real client.
export const OPENCODE_PROJECT_ID = "global"

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high"

// ---------------------------------------------------------------------------
// Model catalog + routing
// ---------------------------------------------------------------------------
// The zen edge routes each model by FORMAT, and free models live on different
// formats (probed 2026-09-24 + 2026-10-10, opencode zen + models.opencode.ai
// catalog + docs table):
//   - muse-spark-1.3-contributor-free  -> "openai"  (/zen/v1/responses)
//   - mimo-v2.6-flash-free             -> "oa-compat" (/zen/v1/chat/completions)
//     (on /v1/responses the upstream 500s; the CLI ships it via
//      @ai-sdk/openai-compatible, i.e. chat completions)
//   - space-bunny-free                 -> "oa-compat"
//     (on /v1/responses it 401s "Model space-bunny-free is not supported
//      for format openai")
//   - step-5-preview-free              -> "oa-compat" (same route as
//     space-bunny; confirmed 200 on the real edge 2026-10-10)
//   - deepseek-v4.1-flash-free         -> "oa-compat" (probed 2026-10-16:
//     /inference/v1/responses 400 ModelProtocolUnsupported, chat/completions 200)
//   - glm-5.3-flash-free               -> "oa-compat" (probed 2026-10-16:
//     /inference/v1/responses 400 ModelProtocolUnsupported, chat/completions 200)
// The muse paths (types.ts + lower*.ts + chat-upstream-less handlers) must
// stay untouched; new models therefore route through a dedicated converter
// (_lib/chat-upstream.ts) while muse keeps using the Responses upstream.
export const MODEL_MUSE = "muse-spark-1.3-contributor-free"
export const MODEL_MIMO = "mimo-v2.6-flash-free"
export const MODEL_SPACE_BUNNY = "space-bunny-free"
export const MODEL_STEP5 = "step-5-preview-free"
export const MODEL_DEEPSEEK = "deepseek-v4.1-flash-free"
export const MODEL_GLM = "glm-5.3-flash-free"
/** 实验模型: 与 muse 同一上游, 但启用代理层 goal 自动续轮 (见 _lib/goal.ts)。 */
export const MODEL_GOAL = "muse-spark-1.3-contributor-goal"

export type UpstreamFormat = "responses" | "oa-compat"

export interface ModelInfo {
  /** Client-facing model id (accepts several aliases per upstream model). */
  id: string
  /** Human display name as reported by /v1/models. */
  name: string
  upstream: UpstreamFormat
  description: string
  contextWindow: number
  maxOutputTokens: number
  /** Reasoning effort values accepted upstream ([] = no effort control). */
  efforts: readonly string[]
  /** Convenience: keep muse defaults working via the old MODEL_ID constant. */
  isMuse?: boolean
  /** goal 实验模型标记: 上游仍走 muse, 但门面为其启用自动续轮。 */
  isGoal?: boolean
  /** 发往上游的模型 id (缺省用 id 自身; goal 模型填 muse id, 上游不认识 goal id)。 */
  upstreamId?: string
}

// Effort levels come from the models.opencode.ai catalog (reasoning_options)
// verified against the real edge with a per-value probe (2026-09-24,
// scripts/probe-reasoning-efforts.ts):
//   - muse: none..xhigh accepted, max 400s (invalid parameters).
//   - mimo: reasoning is ALWAYS ON; reasoning_effort is tolerated (200) but
//     has no effect, so no effort levels are advertised or sent.
//   - space-bunny: minimal/low/medium/high/xhigh/max all 200; "none" 400s
//     (upstream invalid_request_error) even though the catalog omits it —
//     the edge accepts MORE than the catalog lists, except none.
//   - step-5-preview-free: minimal/low/medium/high/xhigh/max all 200
//     (scripts/probe-step5-efforts.ts, 2026-10-10). "none" ALSO 400s — early
//     in the same probe round it briefly returned 200, but the edge now
//     answers 400 "Reasoning is mandatory for this endpoint and cannot be
//     disabled" (re-probed twice, scripts/probe-step5-none.ts), so the
//     clampEffortForModel none->minimal rule covers step-5 as well.
const MUSE_INFO: ModelInfo = {
  id: MODEL_MUSE,
  name: "Muse Spark 1.3 Contributor Free (opencode zen)",
  upstream: "responses",
  description:
    "Muse Spark 1.3 Contributor (free tier) served via opencode zen with encrypted-reasoning replay. Any unknown model id falls back here.",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_000,
  efforts: REASONING_EFFORTS,
  isMuse: true,
}
const MIMO_INFO: ModelInfo = {
  id: MODEL_MIMO,
  name: "MiMo-V2.6-Flash Free",
  upstream: "oa-compat",
  description:
    "MiMo Flash for multimodal coding agents and long-context automation (free tier). Reasoning is always on; effort control is not supported.",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  efforts: [],
}
const SPACE_BUNNY_INFO: ModelInfo = {
  id: MODEL_SPACE_BUNNY,
  name: "Space Bunny Free",
  upstream: "oa-compat",
  description:
    "Anonymous preview reasoning model for coding, agentic tasks, tool use, and multimodal input (free tier, limited time). Reasoning is always on; effort levels minimal–max, with none clamped to minimal.",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_000,
  efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
}
// models.dev catalog (opencode/step-5-preview-free, 2026-10-10): context
// 1,000,000 / output 65,536, reasoning + attachment + tool_call all true.
// The shipped CLI clamps output to OUTPUT_TOKEN_MAX (32_000, see
// packages/opencode/src/provider/transform.ts in the upstream repo), so the
// proxy advertises the same effective cap as the other catalog entries.
const STEP5_INFO: ModelInfo = {
  id: MODEL_STEP5,
  name: "Step 5 Preview Free",
  upstream: "oa-compat",
  description:
    "Step 5 preview reasoning model (free tier, limited time) served via opencode zen with tool calling and multimodal input. Reasoning is mandatory; effort levels minimal–max, with none clamped to minimal.",
  contextWindow: 1_000_000,
  maxOutputTokens: 32_000,
  efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
}
// models.opencode.ai catalog (opencode/deepseek-v4.1-flash-free, read
// 2026-10-16): family "deepseek-flash", release 2026-09-10, attachment +
// tool_call + structured_output + temperature true, reasoning_options
// [{type:"effort", values:["low","high","max"]}], interleaved field
// `reasoning_content`, limit context 200,000 / output 32,000, cost 0/0/0.
// Live-probed 2026-10-16 (scripts/probe-deepseek-routing.ts):
//   - format is oa-compat ONLY — `/inference/v1/chat/completions` 200,
//     `/inference/v1/responses` 400 `ModelProtocolUnsupported`
//     ("Model does not support this protocol.").
//   - thinking streams on `delta.reasoning_content` (the catalog's interleaved
//     field; OaCompatRaiser already reads it).
//   - every effort string is tolerated (200, reasoning still emitted), but the
//     catalog documents only low/high/max, so the proxy advertises and forwards
//     exactly those and `clampEffortForModel` drops the rest.
const DEEPSEEK_INFO: ModelInfo = {
  id: MODEL_DEEPSEEK,
  name: "DeepSeek V4.1 Flash Free",
  upstream: "oa-compat",
  description:
    "DeepSeek V4.1 Flash model for reasoning and agentic coding (free tier). Thinking streams as reasoning_content; effort levels low/high/max.",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  efforts: ["low", "high", "max"],
}
// models.opencode.ai catalog (opencode/glm-5.3-flash-free, read 2026-10-16):
// family "glm-flash", release 2026-08-26, attachment + tool_call +
// structured_output + temperature true, reasoning_options
// [{type:"effort", values:["low","high","max"]}], interleaved field
// `reasoning_content`, modalities input text/image/video/pdf, limit context
// 200,000 / output 32,000, cost 0/0/0 (canonical id zhipuai/glm-5.3-flash).
// Live-probed 2026-10-16 (scripts/probe-deepseek-routing.ts glm-5.3-flash-free):
//   - format is oa-compat ONLY — `/inference/v1/chat/completions` 200,
//     `/inference/v1/responses` 400 `ModelProtocolUnsupported`
//     ("Model does not support this protocol.").
//   - thinking streams on `delta.reasoning_content`.
//   - every effort string is tolerated (200) but the catalog documents only
//     low/high/max, so the proxy advertises and forwards exactly those and
//     `clampEffortForModel` drops the rest (none clamps to low).
const GLM_INFO: ModelInfo = {
  id: MODEL_GLM,
  name: "GLM-5.3-Flash Free",
  upstream: "oa-compat",
  description:
    "Native multimodal GLM model for efficient coding and long-horizon agent tasks (free tier). Thinking streams as reasoning_content; effort levels low/high/max.",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  efforts: ["low", "high", "max"],
}
// 实验模型: 与 muse 同一上游 (upstream responses 格式, 32K 输出),
// 区别仅在于门面为其启用 goal 自动续轮: 无工具干净收尾时先过 judge,
// 判未完成则自动续一轮 (cap 见 MP_GOAL_MAX_ROUNDS)。上游永远收到 muse id。
const GOAL_INFO: ModelInfo = {
  id: MODEL_GOAL,
  name: "Muse Spark 1.3 Contributor Goal (auto-continue experiment)",
  upstream: "responses",
  upstreamId: MODEL_MUSE,
  description:
    "Same upstream as muse-spark-1.3-contributor-free, plus proxy-level goal check: a clean tool-less turn is judged (by the same model) and auto-continued when incomplete. Experimental; usage only reflects the final turn.",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_000,
  efforts: REASONING_EFFORTS,
  isGoal: true,
}

export const MODELS: Record<string, ModelInfo> = {
  [MODEL_MUSE]: MUSE_INFO,
  [MODEL_MIMO]: MIMO_INFO,
  [MODEL_SPACE_BUNNY]: SPACE_BUNNY_INFO,
  [MODEL_STEP5]: STEP5_INFO,
  [MODEL_DEEPSEEK]: DEEPSEEK_INFO,
  [MODEL_GLM]: GLM_INFO,
  [MODEL_GOAL]: GOAL_INFO,
}

export const DEFAULT_MODEL_ID = MODEL_MUSE

/**
 * Clamp a facade-mapped effort to the levels a model actually accepts.
 *
 * Returns undefined when the model has no effort control (mimo: reasoning is
 * always on, the field is dropped) or the requested value is undefined.
 * space-bunny and step-5 reject "none" upstream (400), so it clamps to their
 * lowest accepted level instead of being forwarded. Muse keeps its historical
 * whitelist untouched (REASONING_EFFORTS, which already contains none).
 */
export function clampEffortForModel(model: ModelInfo, effort: string | undefined): string | undefined {
  if (effort === undefined || model.efforts.length === 0) return undefined
  if ((model.efforts as readonly string[]).includes(effort)) return effort
  if (effort === "none") return model.efforts[0]
  return undefined
}

/**
 * Resolve a client-requested model id to a catalog entry.
 *
 * Aliases collapse onto the same upstream free model (e.g. the paid zen
 * name "mimo-v2.6-flash" is served by the free upstream variant), and any
 * unknown id keeps the historical muse behavior (never an error).
 */
export function resolveModel(requested: unknown): ModelInfo {
  if (typeof requested !== "string" || requested.length === 0) return MUSE_INFO
  const direct = MODELS[requested]
  if (direct) return direct
  const normalized = requested.toLowerCase()
  if (normalized.startsWith("mimo")) return MIMO_INFO
  if (normalized.startsWith("deepseek")) return DEEPSEEK_INFO
  if (normalized.startsWith("glm")) return GLM_INFO
  if (normalized.includes("space-bunny")) return SPACE_BUNNY_INFO
  if (normalized.includes("step-5") || normalized.includes("step5")) return STEP5_INFO
  if (normalized.includes("muse")) return MUSE_INFO
  return MUSE_INFO
}

// Legacy alias: identical to MODEL_MUSE (historical lower modules + tests
// reference MODEL_ID; the muse path keeps working unchanged).
export const MODEL_ID = MODEL_MUSE
export const MODEL_NAME = "Muse Spark 1.3 Contributor Free (opencode zen)"
// opencode OUTPUT_TOKEN_MAX (packages/opencode/src/provider/transform.ts).
export const MAX_OUTPUT_TOKENS = 32_000

// ---------------------------------------------------------------------------
// Upstream (OpenAI Responses API) types
// ---------------------------------------------------------------------------

export interface UpstreamTextContent {
  type: "input_text"
  text: string
}

export interface UpstreamImageContent {
  type: "input_image"
  image_url: string
}

export type UpstreamUserContent = UpstreamTextContent | UpstreamImageContent

export type UpstreamInputItem =
  | { role: "system"; content: string }
  | { role: "user"; content: UpstreamUserContent[] }
  | { role: "assistant"; content: Array<{ type: "output_text"; text: string }> }
  | {
      type: "reasoning"
      id: string
      summary: Array<{ type: "summary_text"; text: string }>
      encrypted_content: string | null
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }

export interface UpstreamTool {
  type: "function"
  name: string
  description: string
  parameters: Record<string, unknown>
  /** ai-sdk emits strict:false on opencode tools; keep the field available. */
  strict?: boolean
}

// The zen responses endpoint only supports tool_choice:"auto" (or omitting
// the field): "none", "required", and named-function choices return 400
// "only \"auto\" is supported for tool_choice" (probed 2026-09-18).
export type UpstreamToolChoice = "auto"

export interface UpstreamRequest {
  model: string
  input: UpstreamInputItem[]
  stream: true
  store: false
  include: ["reasoning.encrypted_content"]
  /** Session-scoped prompt cache key; the CLI sends its session id. */
  prompt_cache_key?: string
  reasoning?: { effort?: ReasoningEffort; summary?: "auto" }
  instructions?: string
  tools?: UpstreamTool[]
  tool_choice?: UpstreamToolChoice
  temperature?: number
  top_p?: number
  max_output_tokens?: number
}

export interface UpstreamUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number } | null
  output_tokens_details?: { reasoning_tokens?: number } | null
  total_tokens?: number
}

export interface UpstreamStreamItem {
  type: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  encrypted_content?: string | null
  summary?: Array<{ type: "summary_text"; text: string }>
}

export interface UpstreamEvent {
  type: string
  delta?: string
  item_id?: string
  summary_index?: number
  item?: UpstreamStreamItem
  response?: {
    id?: string
    usage?: UpstreamUsage | null
    error?: { code?: string | null; message?: string | null } | null
    incomplete_details?: { reason?: string } | null
  } | null
  code?: string
  message?: string
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions facade types
// ---------------------------------------------------------------------------

export interface ChatToolCall {
  index: number
  id?: string
  type?: "function"
  function?: { name?: string; arguments?: string }
}

export interface ChatChunkDelta {
  role?: "assistant"
  content?: string | null
  reasoning_content?: string | null
  /** OpenRouter-style extension carrying encoded encrypted-reasoning replay data. */
  reasoning_details?: unknown
  tool_calls?: ChatToolCall[]
}

export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface ChatChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<{
    index: number
    delta: ChatChunkDelta
    finish_reason: string | null
  }>
  usage?: ChatUsage
}

export interface ChatTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface ChatCompletionRequest {
  model?: string
  messages?: unknown[]
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  max_completion_tokens?: number
  reasoning_effort?: unknown
  reasoning?: unknown
  tools?: ChatTool[]
  tool_choice?: unknown
}
