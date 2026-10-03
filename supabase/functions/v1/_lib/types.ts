// Wire types for the OpenAI Chat Completions facade and the opencode zen
// Responses API upstream. Zero runtime dependencies.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const UPSTREAM_URL = "https://opencode.ai/zen/v1/responses"
// opencode zen free models accept the literal api key "public" when no zen
// account key is configured (see opencode provider.ts custom loader).
export const UPSTREAM_API_KEY = "public"
// The anonymous free tier is gated on an opencode-client fingerprint:
// request headers (UA + x-opencode-* ids) AND the body's tools array (must
// carry the opencode builtin tool names, see _lib/tools.ts). Recent zen
// releases tightened this fingerprint; non-matching traffic gets
// "OpenCode's free tier can only be used from within OpenCode" (the gate
// lives in the closed-source edge; the open-source repo only tells us what
// a real client sends).
//
// UA mirrors what the shipped opencode CLI emits on the wire (captured
// 2026-09-18): ai-sdk/provider-utils + runtime/bun suffixes appended to
// `opencode/<version>`. Note the in-repo request.ts constructs a different
// (shorter) UA — the shipped binary is what passes the gate, so keep the
// captured form. Re-verify on every upstream version bump.
export const OPENCODE_VERSION = "1.18.31"
export const OPENCODE_CLIENT = "cli"
export const UPSTREAM_USER_AGENT = `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`
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
// formats (probed 2026-09-24, opencode 1.18.32 + models.opencode.ai catalog):
//   - muse-spark-1.3-contributor-free  -> "openai"  (/zen/v1/responses)
//   - mimo-v2.6-flash-free             -> "oa-compat" (/zen/v1/chat/completions)
//     (on /v1/responses the upstream 500s; the CLI ships it via
//      @ai-sdk/openai-compatible, i.e. chat completions)
//   - space-bunny-free                 -> "oa-compat"
//     (on /v1/responses it 401s "Model space-bunny-free is not supported
//      for format openai")
// The muse paths (types.ts + lower*.ts + chat-upstream-less handlers) must
// stay untouched; new models therefore route through a dedicated converter
// (_lib/chat-upstream.ts) while muse keeps using the Responses upstream.
export const MODEL_MUSE = "muse-spark-1.3-contributor-free"
export const MODEL_MIMO = "mimo-v2.6-flash-free"
export const MODEL_SPACE_BUNNY = "space-bunny-free"

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

export const MODELS: Record<string, ModelInfo> = {
  [MODEL_MUSE]: MUSE_INFO,
  [MODEL_MIMO]: MIMO_INFO,
  [MODEL_SPACE_BUNNY]: SPACE_BUNNY_INFO,
}

export const DEFAULT_MODEL_ID = MODEL_MUSE

/**
 * Clamp a facade-mapped effort to the levels a model actually accepts.
 *
 * Returns undefined when the model has no effort control (mimo: reasoning is
 * always on, the field is dropped) or the requested value is undefined.
 * space-bunny rejects "none" upstream (400), so it clamps to its lowest
 * accepted level instead of being forwarded. Muse keeps its historical
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
  if (normalized.includes("space-bunny")) return SPACE_BUNNY_INFO
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
