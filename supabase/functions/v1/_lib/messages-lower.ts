// Lower an inbound Anthropic Messages API request body (POST /v1/messages)
// into an opencode zen upstream Responses request. Kept separate from
// lower.ts / responses-lower.ts on purpose: the chat completions and
// responses facades must stay byte-for-byte untouched.
//
// Mappings:
//   - system (top-level or role:"system"/"developer" in messages) -> first role:"system" item
//   - user text block / string               -> input_text
//   - user image block (base64/url source)   -> input_image (data URL / URL)
//   - assistant text block / string          -> output_text
//   - assistant tool_use block               -> function_call (call_id = id)
//   - user tool_result block                 -> function_call_output
//   - assistant/user thinking block          -> dropped (upstream replay is
//      done via OpenAI encrypted_content, which the Anthropic facade does
//      not carry; dropping keeps multi-turn memory working via plain text)
//   - tools {name, input_schema}             -> upstream function tools,
//      appended after the stubbed opencode builtin set (free-tier fingerprint)
//   - tool_choice                            -> always "auto" upstream
//   - thinking.budget_tokens                 -> reasoning.effort whitelist
//   - max_tokens (required)                  -> max_output_tokens (clamped)
//
// Anthropic spec notes enforced here:
//   - max_tokens is REQUIRED (the real API 400s without it)
//   - stop_sequences / metadata / top_k are accepted but ignored (upstream
//     has no equivalent or effect)

import { appendClientTools } from "./tools.ts"
import {
  DEFAULT_REASONING_EFFORT,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  type ReasoningEffort,
  type UpstreamInputItem,
  type UpstreamRequest,
  type UpstreamTool,
} from "./types.ts"

export type LowerResult =
  | { request: UpstreamRequest; clientToolNames: Set<string> }
  | { error: { status: number; message: string; code?: string } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

// Anthropic thinking config -> upstream reasoning effort whitelist.
// budget_tokens < 2048 -> low, < 8192 -> medium, < 24576 -> high, else xhigh;
// {type:"disabled"} maps to "none"; absent falls back to the default effort.
function effortFromThinking(body: Record<string, unknown>): ReasoningEffort {
  const thinking = body.thinking
  if (isRecord(thinking)) {
    if (thinking.type === "disabled") return "none"
    if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number" && thinking.budget_tokens > 0) {
      const budget = thinking.budget_tokens
      if (budget < 2048) return "low"
      if (budget < 8192) return "medium"
      if (budget < 24576) return "high"
      return "xhigh"
    }
  }
  return DEFAULT_REASONING_EFFORT
}

// Anthropic image block source -> URL the upstream input_image accepts.
function imageSourceToUrl(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined
  if (source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
    return `data:${source.media_type};base64,${source.data}`
  }
  if (source.type === "url" && typeof source.url === "string") return source.url
  return undefined
}

function systemToText(value: unknown): string | undefined | { error: true } {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    const texts: string[] = []
    for (const part of value) {
      if (!isRecord(part) || typeof part.text !== "string") return { error: true }
      if (part.type !== undefined && part.type !== "text" && part.type !== "input_text") return { error: true }
      texts.push(part.text)
    }
    return texts.join("\n")
  }
  return { error: true }
}

// tool_result content: a string or content blocks; text blocks are joined,
// non-text blocks are JSON-stringified so nothing is silently lost.
function toolResultOutput(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        parts.push(part.text)
      } else if (part !== undefined && part !== null) {
        parts.push(JSON.stringify(part))
      }
    }
    return parts.join("\n")
  }
  if (isRecord(content)) return JSON.stringify(content)
  if (typeof content === "number" || typeof content === "boolean") return String(content)
  return ""
}

function userBlocksToParts(
  blocks: Array<Record<string, unknown>>,
  state: { input: UpstreamInputItem[] },
): { error: true } | undefined {
  const parts: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> = []
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "input_text", text: block.text })
      continue
    }
    if (block.type === "image") {
      const url = imageSourceToUrl(block.source)
      if (url === undefined) return { error: true }
      parts.push({ type: "input_image", image_url: url })
      continue
    }
    if (block.type === "tool_result") {
      const callId = asString(block.tool_use_id)
      if (callId === undefined) return { error: true }
      state.input.push({ type: "function_call_output", call_id: callId, output: toolResultOutput(block.content) })
      continue
    }
    // thinking blocks and unknown block types are dropped on input.
    continue
  }
  if (parts.length > 0) state.input.push({ role: "user", content: parts })
  return undefined
}

function assistantBlocksToItems(
  blocks: Array<Record<string, unknown>>,
  state: { input: UpstreamInputItem[] },
): { error: true } | undefined {
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text)
      continue
    }
    if (block.type === "tool_use") {
      const id = asString(block.id)
      const name = asString(block.name)
      if (id === undefined || name === undefined) return { error: true }
      const input = isRecord(block.input) ? JSON.stringify(block.input) : "{}"
      if (texts.length > 0) {
        state.input.push({ role: "assistant", content: [{ type: "output_text", text: texts.join("") }] })
        texts.length = 0
      }
      state.input.push({ type: "function_call", call_id: id, name, arguments: input })
      continue
    }
    // thinking blocks are dropped on input (see header note).
    continue
  }
  if (texts.length > 0) {
    state.input.push({ role: "assistant", content: [{ type: "output_text", text: texts.join("") }] })
  }
  return undefined
}

// Anthropic tools {name, description?, input_schema?} -> upstream function
// tools; appendClientTools then handles builtin stubbing + shadow filtering.
function clientTools(value: unknown): UpstreamTool[] {
  const client: UpstreamTool[] = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) continue
      const name = asString(entry.name)
      if (name === undefined) continue
      client.push({
        type: "function",
        name,
        description: asString(entry.description) ?? "",
        parameters: isRecord(entry.input_schema) ? entry.input_schema : { type: "object", properties: {} },
      })
    }
  }
  return client
}

function clampMaxTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Math.floor(value), MAX_OUTPUT_TOKENS)
}

export interface LowerOptions {
  /** opencode session id used as the upstream prompt_cache_key. */
  sessionId?: string
}

export function lowerMessagesRequest(body: unknown, options: LowerOptions = {}): LowerResult {
  if (!isRecord(body)) {
    return { error: { status: 400, message: "request body must be a JSON object" } }
  }

  const messages = body.messages
  if (!Array.isArray(messages)) {
    return { error: { status: 400, message: "messages: field required (must be an array)", code: "missing_messages" } }
  }

  // Anthropic spec: max_tokens is required.
  const maxTokens = clampMaxTokens(body.max_tokens)
  if (maxTokens === undefined) {
    return {
      error: { status: 400, message: "max_tokens: field required (must be a positive number)", code: "missing_max_tokens" },
    }
  }

  const state = { input: [] as UpstreamInputItem[] }

  const system = systemToText(body.system)
  if (system && typeof system === "object") {
    return { error: { status: 400, message: "system: unsupported content (string or text blocks only)" } }
  }
  // Claude Code 会把系统提示以 role:"system" 的消息直接放进 messages 数组，
  // 而 Anthropic 规范只允许顶层 system 参数，这里兼容收拢为首条上游 system。
  const systemTexts: string[] = []
  if (typeof system === "string" && system.length > 0) systemTexts.push(system)

  for (const entry of messages) {
    if (!isRecord(entry)) {
      return { error: { status: 400, message: "each message must be an object" } }
    }
    const role = entry.role
    const content = entry.content

    if (role === "user") {
      if (typeof content === "string") {
        state.input.push({ role: "user", content: [{ type: "input_text", text: content }] })
        continue
      }
      if (Array.isArray(content)) {
        const error = userBlocksToParts(content as Array<Record<string, unknown>>, state)
        if (error) return { error: { status: 400, message: "unsupported user content block" } }
        continue
      }
      return { error: { status: 400, message: "user message content must be a string or content blocks" } }
    }

    if (role === "assistant") {
      if (typeof content === "string") {
        if (content.length > 0) {
          state.input.push({ role: "assistant", content: [{ type: "output_text", text: content }] })
        }
        continue
      }
      if (Array.isArray(content)) {
        const error = assistantBlocksToItems(content as Array<Record<string, unknown>>, state)
        if (error) return { error: { status: 400, message: "unsupported assistant content block" } }
        continue
      }
      return { error: { status: 400, message: "assistant message content must be a string or content blocks" } }
    }

    if (role === "system" || role === "developer") {
      const text = systemToText(content)
      if (text && typeof text === "object") {
        return { error: { status: 400, message: "system message content must be a string or text blocks" } }
      }
      if (typeof text === "string" && text.length > 0) systemTexts.push(text)
      continue
    }

    return { error: { status: 400, message: `unsupported message role: ${String(role)}` } }
  }

  const request: UpstreamRequest = {
    model: MODEL_ID,
    input: state.input,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: effortFromThinking(body), summary: "auto" },
    max_output_tokens: maxTokens,
  }
  if (options.sessionId) request.prompt_cache_key = options.sessionId

  if (systemTexts.length > 0) {
    request.input = [{ role: "system", content: systemTexts.join("\n") }, ...request.input]
  }

  // Free-tier fingerprint: full opencode builtin set (stubbed) + client tools;
  // tool_choice is always "auto" upstream (same as the other facades).
  const client = clientTools(body.tools)
  request.tools = appendClientTools(client)
  request.tool_choice = "auto"

  if (typeof body.temperature === "number") request.temperature = body.temperature
  if (typeof body.top_p === "number") request.top_p = body.top_p

  return { request, clientToolNames: new Set(client.map((tool) => tool.name)) }
}
