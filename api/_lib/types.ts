// Wire types for the OpenAI Chat Completions facade and the opencode zen
// Responses API upstream. Zero runtime dependencies.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Endpoint moved 2026-10-14: the legacy /zen/v1 path now answers every
// inference call with 403 FreeTierError; the live client (2.0.29) reads
// https://opencode.ai/inference/v1 from the runtime catalog
// (models.opencode.ai/api.json -> providers.opencode.api) and posts there.
// 2026-10-17: the catalog's provider.api moved again — openai-compatible
// entries now read https://opencode.ai/inference/openai/v1 (a second mount of
// the same gate; live-probed both mounts 200 with identical bodies, and
// stream:false answers 403 FreeTierError on BOTH, so the free tier stays
// stream:true-only). The oa-compat branch now posts to the /inference/openai/v1
// mount, mirroring the shipped client. The muse /responses mount is unusable
// since the muse deprecation; UPSTREAM_URL below remains only for probe scripts.
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
//
// 2026-10-17 re-verification (npm latest 2.0.32, repo tip 4a53028): UA builder
// and header set unchanged (packages/core/src/app.ts + session/model-request.ts);
// the tool set grew a patch plugin but the wire fingerprint keeps passing with
// the same 12 builtin definitions — re-verified live on 2026-10-17.
export const OPENCODE_VERSION = "2.0.32"
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
// 2026-10-17: the muse free model was retired upstream — the zen edge answers
// every muse id with `Model muse-spark-1.3-contributor-free has been
// deprecated.` while muse-spark-1.2 got the same treatment, and NO live free
// model speaks the Responses protocol anymore (nemotron/beam etc. all answer
// /inference/v1/responses with 400 ModelProtocolUnsupported). The muse ids now
// resolve to the deepseek-v4.1-flash-free oa-compat entry (upstreamId alias),
// so THEY and every unknown-id fallback ride the chat-completions branch
// (_lib/chat-upstream.ts) like the other free models.
export const MODEL_MUSE = "muse-spark-1.3-contributor-free"
export const MODEL_MIMO = "mimo-v2.6-flash-free"
export const MODEL_SPACE_BUNNY = "space-bunny-free"
export const MODEL_STEP5 = "step-5-preview-free"
export const MODEL_DEEPSEEK = "deepseek-v4.1-flash-free"
export const MODEL_GLM = "glm-5.3-flash-free"
// 2026-10-19 free-tier re-audit (scripts/probe-free-sweep.ts): the live free
// set gained six entries since the glm rollout — five `-free` ids plus
// `big-pickle`, the only live free entry WITHOUT the suffix (catalog cost
// 0/0/0). Every one answers on the oa-compat chat mount, so they ride the
// shared converter unchanged (see the per-entry comments below).
export const MODEL_BIG_PICKLE = "big-pickle"
export const MODEL_LONGCAT = "longcat-2.5-preview-free"
export const MODEL_BEAM = "beam-free"
export const MODEL_NEMOTRON_LIGHTNING = "nemotron-3.5-lightning-free"
export const MODEL_NEMOTRON_ULTRA = "nemotron-3-ultra-free"
export const MODEL_NEMOTRON_SUPER_VL = "nemotron-3.5-super-vl-free"
/** 实验模型: API id 保留, 上游随 muse 弃用重落到 deepseek (upstreamId+isGoal)。 */
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
  /** Historical muse marker (kept for compat; the entry is now a deepseek alias). */
  isMuse?: boolean
  /** goal 实验模型标记: 上游与 base 模型一致, 但门面为其启用自动续轮。 */
  isGoal?: boolean
  /** 发往上游的模型 id (缺省用 id 自身; muse/goal 等弃用别名填存活模型 id)。 */
  upstreamId?: string
  /**
   * /v1/models 是否上架 (缺省 true)。上游退役的 id 留在 MODELS 供历史客户端
   * 解析 (upstreamId 别名到存活模型), 但不上架——只改目录露出, 代码不删。
   */
  listed?: boolean
}

// Effort levels come from the models.opencode.ai catalog (reasoning_options)
// verified against the real edge with a per-value probe (2026-09-24,
// scripts/probe-reasoning-efforts.ts):
//   - muse: retired upstream 2026-10-17 (deprecation); the muse entry now
//     aliases deepseek-v4.1-flash-free so its effort levels are deepseek's
//     low/high/max (undocumented levels dropped, none clamps to low).
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
// The muse free model was retired upstream on 2026-10-17 — every muse id
// (1.2/1.3) answers "has been deprecated." BOTH on /inference/v1/responses and
// /inference/v1/chat/completions, and no live free model speaks the Responses
// protocol (probe: nemotron-3.5-super-vl-free / beam-free both 400
// ModelProtocolUnsupported on the responses mount). To keep the historical
// "any model id resolves somewhere" contract the muse entry stays in the
// catalog as an ALIAS of deepseek-v4.1-flash-free: id is preserved so clients
// echo their own request back, upstreamId routes the wire traffic to the live
// oa-compat model, and efforts/metadata mirror the actually served model
// (probed 2026-10-17: deepseek 200 on both chat mounts; responses mount
// ModelProtocolUnsupported).
const MUSE_INFO: ModelInfo = {
  id: MODEL_MUSE,
  name: "Muse Spark 1.3 Contributor Free (deprecated upstream, served by DeepSeek V4.1 Flash Free)",
  upstream: "oa-compat",
  description:
    " muse-spark free ids were retired upstream (2026-10-17); requests resolve to the live DeepSeek V4.1 Flash Free (free tier). Any unknown model id still falls back here.",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  efforts: ["low", "high", "max"],
  isMuse: true,
  upstreamId: MODEL_DEEPSEEK,
  // 上游 410 ModelDeprecated (1.3 自 2026-10-17, 1.2 于 2026-10-19 复核同)
  // ——保留 id 解析, 不再上架。
  listed: false,
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
// 2026-10-19: step-5 stayed retired upstream — both chat mounts answer 400
// `Upstream request failed: Model is unavailable.` (re-probed by
// scripts/probe-free-sweep.ts, matching 2026-10-17). Same treatment as the
// retired muse ids: the id stays in the catalog so historical clients keep
// resolving, but the wire traffic aliases onto a live oa-compat model
// (deepseek) via `upstreamId`, and efforts/metadata mirror the model actually
// served. Delisted from /v1/models so the catalog never advertises a dead
// entry.
const STEP5_INFO: ModelInfo = {
  id: MODEL_STEP5,
  name: "Step 5 Preview Free (retired upstream, served by DeepSeek V4.1 Flash Free)",
  upstream: "oa-compat",
  upstreamId: MODEL_DEEPSEEK,
  description:
    "Step 5 preview reasoning model (free tier, limited time) was retired upstream on 2026-10-17 (400 Model is unavailable). Requests resolve to the live DeepSeek V4.1 Flash Free (free tier).",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  efforts: ["low", "high", "max"],
  listed: false,
}
// models.opencode.ai catalog (opencode/big-pickle, read 2026-10-19): the only
// live free entry without a `-free` suffix (cost 0/0/0 in the catalog). family
// "big-pickle", release 2025-10-17, reasoning true with an EMPTY
// reasoning_options list (always on, no levels to send — same shape as mimo),
// interleaved `reasoning_content`, tool_call + structured_output + temperature
// true, text-only input, limit context 200,000 / input 160,000 / output
// 32,000 (the only entry whose catalog output already equals the proxy-wide
// OUTPUT_TOKEN_MAX cap). catalog provider.api -> /inference/openai/v1, i.e.
// the oa-compat chat mount.
const BIG_PICKLE_INFO: ModelInfo = {
  id: MODEL_BIG_PICKLE,
  name: "Big Pickle",
  upstream: "oa-compat",
  description:
    "Reasoning model for deliberate analysis, multi-step problem solving, and tool use (free tier). Reasoning is always on; effort control is not supported.",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  efforts: [],
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
// models.opencode.ai catalog (opencode/longcat-2.5-preview-free, read
// 2026-10-19): family "longcat", release 2026-09-25, attachment + tool_call +
// temperature true, reasoning_options [{type:"toggle"}] (reasoning always on,
// no effort levels to send), interleaved `reasoning_content`, limit context
// 1,000,000 / output 131,072 (advertised output follows the proxy-wide
// OUTPUT_TOKEN_MAX cap of 32,000 like every other entry). catalog provider.api
// -> /inference/openai/v1 (oa-compat chat mount).
const LONGCAT_INFO: ModelInfo = {
  id: MODEL_LONGCAT,
  name: "LongCat 2.5 Preview Free",
  upstream: "oa-compat",
  description:
    "Meituan's multimodal reasoning model for coding and agent tasks, with image understanding and a 1M-token context window (free tier). Reasoning is always on; effort control is not supported.",
  contextWindow: 1_000_000,
  maxOutputTokens: 32_000,
  efforts: [],
}
// models.opencode.ai catalog (opencode/beam-free, read 2026-10-19): family
// "beam", release 2026-10-05, tool_call + structured_output + temperature true
// (text-only input), reasoning_options [{type:"effort", values:["low",
// "medium","high","xhigh","max"]}], interleaved `reasoning_content`, limit
// context 1,048,576 / output 131,072 (advertised capped to 32,000). catalog
// provider.api -> /inference/openai/v1 (oa-compat chat mount).
const BEAM_INFO: ModelInfo = {
  id: MODEL_BEAM,
  name: "Beam Free",
  upstream: "oa-compat",
  description:
    "Sparse mixture-of-experts reasoning model with 23B active parameters for coding and agentic workflows (free tier). Thinking streams as reasoning_content; effort levels low–max.",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_000,
  efforts: ["low", "medium", "high", "xhigh", "max"],
}
// models.opencode.ai catalog (opencode/nemotron-3.5-lightning-free, read
// 2026-10-19): family "nemotron-free", release 2026-08-11, tool_call +
// structured_output + temperature true (text-only), reasoning true with an
// EMPTY reasoning_options list (always on, no levels to send; same shape as
// mimo), interleaved `reasoning_content`, limit context 262,144 / output
// 262,144 (advertised capped to 32,000). catalog provider.api ->
// /inference/openai/v1 (oa-compat chat mount).
const NEMOTRON_LIGHTNING_INFO: ModelInfo = {
  id: MODEL_NEMOTRON_LIGHTNING,
  name: "Nemotron 3.5 Lightning Free",
  upstream: "oa-compat",
  description:
    "Fast NVIDIA Nemotron MoE for reliable agentic tasks across enterprise workloads (free tier). Reasoning is always on; effort control is not supported.",
  contextWindow: 262_144,
  maxOutputTokens: 32_000,
  efforts: [],
}
// models.opencode.ai catalog (opencode/nemotron-3-ultra-free, read 2026-10-19):
// family "nemotron-free", release 2026-06-04, tool_call + temperature true
// (no structured_output, text-only), reasoning true with an EMPTY
// reasoning_options list, interleaved `reasoning_content`, limit context
// 1,000,000 / output 128,000 (advertised capped to 32,000). catalog
// provider.api -> /inference/openai/v1 (oa-compat chat mount).
const NEMOTRON_ULTRA_INFO: ModelInfo = {
  id: MODEL_NEMOTRON_ULTRA,
  name: "Nemotron 3 Ultra Free",
  upstream: "oa-compat",
  description:
    "Largest Nemotron 3 model for maximum open-weight reasoning and agent accuracy (free tier). Reasoning is always on; effort control is not supported.",
  contextWindow: 1_000_000,
  maxOutputTokens: 32_000,
  efforts: [],
}
// models.opencode.ai catalog (opencode/nemotron-3.5-super-vl-free, read
// 2026-10-19): family "nemotron-free", release 2026-10-15, attachment +
// tool_call + temperature true (text + image in), reasoning_options
// [{type:"effort", values:["none","minimal","low","medium","high","xhigh"]}]
// — the only free entry whose documented levels INCLUDE `none`, so `none` is
// forwarded verbatim instead of being clamped; interleaved `reasoning_content`,
// limit context 1,048,576 / output 131,072 (advertised capped to 32,000).
// catalog provider.api -> /inference/openai/v1 (oa-compat chat mount).
const NEMOTRON_SUPER_VL_INFO: ModelInfo = {
  id: MODEL_NEMOTRON_SUPER_VL,
  name: "Nemotron 3.5 Super VL Free",
  upstream: "oa-compat",
  description:
    "NVIDIA vision-language reasoning model for text, image, and video understanding and agentic tool use (free tier). Thinking streams as reasoning_content; effort levels none–xhigh.",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_000,
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
}
// 实验模型: 随 muse 弃用一并重落到 deepseek-v4.1-flash-free (upstreamId,
// oa-compat chat 上游), 门面继续为其启用 goal 自动续轮: 无工具干净收尾时先过
// judge (裁判即本模型自身经由 chat/completions, 见 _lib/goal.ts —— 门禁要求
// 上游流式, judge 也是流式聚合), 判未完成则自动续一轮 (cap 见 MP_GOAL_MAX_ROUNDS)。
// 上游收到 deepseek id。
const GOAL_INFO: ModelInfo = {
  id: MODEL_GOAL,
  name: "Muse Spark 1.3 Contributor Goal (auto-continue experiment, served by DeepSeek V4.1 Flash Free)",
  upstream: "oa-compat",
  upstreamId: MODEL_DEEPSEEK,
  description:
    "Goal auto-continue experiment: a clean tool-less turn is judged (by the served model) and auto-continued when incomplete. Served by DeepSeek V4.1 Flash Free since the muse deprecation (2026-10-17). Experimental; usage only reflects the final turn.",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  efforts: ["low", "high", "max"],
  isGoal: true,
}

export const MODELS: Record<string, ModelInfo> = {
  [MODEL_MUSE]: MUSE_INFO,
  [MODEL_MIMO]: MIMO_INFO,
  [MODEL_SPACE_BUNNY]: SPACE_BUNNY_INFO,
  [MODEL_STEP5]: STEP5_INFO,
  [MODEL_DEEPSEEK]: DEEPSEEK_INFO,
  [MODEL_GLM]: GLM_INFO,
  [MODEL_BIG_PICKLE]: BIG_PICKLE_INFO,
  [MODEL_LONGCAT]: LONGCAT_INFO,
  [MODEL_BEAM]: BEAM_INFO,
  [MODEL_NEMOTRON_LIGHTNING]: NEMOTRON_LIGHTNING_INFO,
  [MODEL_NEMOTRON_ULTRA]: NEMOTRON_ULTRA_INFO,
  [MODEL_NEMOTRON_SUPER_VL]: NEMOTRON_SUPER_VL_INFO,
  [MODEL_GOAL]: GOAL_INFO,
}

export const DEFAULT_MODEL_ID = MODEL_MUSE

/**
 * Clamp a facade-mapped effort to the levels a model actually accepts.
 *
 * Returns undefined when the model has no effort control (mimo / longcat /
 * nemotron lightning+ultra / big-pickle: reasoning is always on, the field is
 * dropped) or the requested value is undefined. space-bunny rejects "none"
 * upstream (400), so it clamps to its lowest accepted level instead of being
 * forwarded. muse / step-5 / goal alias the deepseek entry (deepseek efforts
 * low/high/max), so undocumented levels are dropped and "none" clamps to low;
 * nemotron-3.5-super-vl is the one free entry whose catalog levels document
 * "none", so it is forwarded verbatim (2026-10-19 audit).
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
 * unknown id keeps the historical muse behavior (never an error) — since the
 * 2026-10-17 muse deprecation the muse entry itself aliases the live
 * deepseek-v4.1-flash-free oa-compat model, so muse ids and unknown ids ride
 * the chat-completions branch like every other free model.
 */
export function resolveModel(requested: unknown): ModelInfo {
  if (typeof requested !== "string" || requested.length === 0) return MUSE_INFO
  const direct = MODELS[requested]
  if (direct) return direct
  const normalized = requested.toLowerCase()
  if (normalized.startsWith("mimo")) return MIMO_INFO
  if (normalized.startsWith("deepseek")) return DEEPSEEK_INFO
  if (normalized.startsWith("glm")) return GLM_INFO
  if (normalized.startsWith("longcat")) return LONGCAT_INFO
  if (normalized.includes("big-pickle") || normalized.includes("bigpickle")) return BIG_PICKLE_INFO
  if (normalized.includes("beam")) return BEAM_INFO
  // nemotron family: the three live variants are distinct models, so the
  // qualifier decides (legacy/paid ids without one fall back to the fast
  // Lightning variant, the shape the catalog serves today).
  if (normalized.includes("nemotron")) {
    if (normalized.includes("ultra")) return NEMOTRON_ULTRA_INFO
    if (normalized.includes("super-vl")) return NEMOTRON_SUPER_VL_INFO
    return NEMOTRON_LIGHTNING_INFO
  }
  if (normalized.includes("space-bunny")) return SPACE_BUNNY_INFO
  if (normalized.includes("step-5") || normalized.includes("step5")) return STEP5_INFO
  if (normalized.includes("muse")) return MUSE_INFO
  return MUSE_INFO
}

// Legacy alias: identical to MODEL_MUSE (historical lower modules + tests
// reference MODEL_ID; muse ids keep resolving, now via the deepseek alias).
export const MODEL_ID = MODEL_MUSE
export const MODEL_NAME = "Muse Spark 1.3 Contributor Free (deprecated upstream, served by DeepSeek V4.1 Flash Free)"
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
