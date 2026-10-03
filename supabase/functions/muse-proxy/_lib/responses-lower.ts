// Normalize an inbound OpenAI Responses API request body into an opencode zen
// upstream Responses request. Unlike the chat facade (lower.ts), no semantic
// lowering is required — the upstream already speaks the Responses API — so
// this module only:
//   1. normalizes input shapes (string input, message items, tool items,
//      encrypted-reasoning replay items) into UpstreamInputItem[],
//   2. re-applies the muse-specific fingerprint rules shared with the chat
//      facade: store:false, include reasoning.encrypted_content, reasoning
//      summary "auto", effort whitelisting, the full opencode builtin tool
//      set (stubbed descriptions) with client tools appended, and
//      tool_choice forced to "auto" (the only value upstream accepts).
//
// Kept separate from lower.ts on purpose: the chat completions facade must
// stay byte-for-byte untouched, so no shared mutable logic is modified.

import {
  DEFAULT_REASONING_EFFORT,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type UpstreamInputItem,
  type UpstreamRequest,
  type UpstreamTool,
  type UpstreamToolChoice,
} from "./types.ts"
import { appendClientTools } from "./tools.ts"

export type NormalizeResult =
  | { request: UpstreamRequest; stream: boolean; clientToolNames: Set<string>; nsPrefixByBare: Map<string, string>; customToolNames: Set<string> }
  | { error: { status: number; message: string; code?: string } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function normalizeEffort(value: unknown): ReasoningEffort {
  if (typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value)) {
    return value as ReasoningEffort
  }
  return DEFAULT_REASONING_EFFORT
}

function extractEffort(body: Record<string, unknown>): ReasoningEffort {
  if (isRecord(body.reasoning) && body.reasoning.effort !== undefined) {
    return normalizeEffort(body.reasoning.effort)
  }
  return DEFAULT_REASONING_EFFORT
}

function imageToDataUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (isRecord(value) && typeof value.url === "string") return value.url
  return undefined
}

// User message content: a string or input_text/input_image content parts.
function userContentToParts(content: unknown):
  | { parts: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> }
  | { error: true } {
  const parts: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> = []

  if (typeof content === "string") {
    parts.push({ type: "input_text", text: content })
    return { parts }
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) return { error: true }
      if (part.type === "input_text" && typeof part.text === "string") {
        parts.push({ type: "input_text", text: part.text })
        continue
      }
      if (part.type === "input_image") {
        const url = imageToDataUrl(part.image_url)
        if (url === undefined) return { error: true }
        parts.push({ type: "input_image", image_url: url })
        continue
      }
      return { error: true }
    }
    if (parts.length === 0) return { error: true }
    return { parts }
  }

  return { error: true }
}

// Assistant message content: a string or output_text/refusal content parts.
function assistantContentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      if (!isRecord(part)) return undefined
      if ((part.type === "output_text" || part.type === "refusal") && typeof part.text === "string") {
        texts.push(part.text)
        continue
      }
      return undefined
    }
    return texts.join("")
  }
  return undefined
}

// System/developer message content: a string or input_text/text parts.
function systemContentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      if (!isRecord(part)) return undefined
      if ((part.type === "input_text" || part.type === "text") && typeof part.text === "string") {
        texts.push(part.text)
        continue
      }
      return undefined
    }
    return texts.join("\n")
  }
  return undefined
}

// Reasoning replay items are ALWAYS dropped on input: encrypted_content is
// issued per upstream session, but this proxy mints a fresh opencode
// session id per request, so any replayed blob belongs to a different
// caller and upstream rejects it with "encrypted_content was not issued
// to this caller". Dropping keeps multi-turn working via plain text.
function reasoningReplayItem(_item: Record<string, unknown>): UpstreamInputItem | undefined {
  return undefined
}

function functionCallItem(item: Record<string, unknown>): UpstreamInputItem | { error: true } {
  const callId = asString(item.call_id)
  const rawName = asString(item.name)
  if (callId === undefined || rawName === undefined) return { error: true }
  // 终端回传名为 muse.muse__read_file（点号命名空间 + 双下划线工具名），
  // 上游只认识裸名 read_file，取最后一段剥离命名空间后透传。
  const name = rawName.split(".").pop()!.split("__").pop()!
  // 原生 custom_tool_call 回放：input 为裸 JS 字符串，转写为 function 参数 JSON。
  const args = asString(item.arguments) ?? (typeof item.input === "string" ? JSON.stringify({ input: item.input }) : "{}")
  return { type: "function_call", call_id: callId, name, arguments: args }
}

function functionCallOutputItem(item: Record<string, unknown>): UpstreamInputItem | { error: true } {
  const callId = asString(item.call_id)
  if (callId === undefined) return { error: true }
  const raw = item.output
  let output: string
  if (typeof raw === "string") {
    output = raw
  } else if (Array.isArray(raw) || isRecord(raw)) {
    output = JSON.stringify(raw)
  } else if (raw === undefined || raw === null) {
    output = ""
  } else if (typeof raw === "number" || typeof raw === "boolean") {
    output = String(raw)
  } else {
    return { error: true }
  }
  return { type: "function_call_output", call_id: callId, output }
}

function messageItem(item: Record<string, unknown>, state: { systemTexts: string[] }): UpstreamInputItem[] | { error: true } {
  const role = asString(item.role)
  if (role === "system" || role === "developer") {
    const text = systemContentToText(item.content)
    if (text === undefined) return { error: true }
    state.systemTexts.push(text)
    return []
  }

  if (role === "user") {
    const parts = userContentToParts(item.content)
    if ("error" in parts) return { error: true }
    return [{ role: "user", content: parts.parts }]
  }

  if (role === "assistant") {
    const text = assistantContentToText(item.content)
    if (text === undefined) return { error: true }
    if (text.length === 0) return []
    return [{ role: "assistant", content: [{ type: "output_text", text }] }]
  }

  return { error: true }
}

// One inbound input item (of either the shorthand `{role, content}` form or
// the typed `{type: ...}` form) into zero or more upstream items.
function normalizeInputItem(
  entry: unknown,
  state: { systemTexts: string[] },
): UpstreamInputItem[] | { error: true } {
  if (!isRecord(entry)) return { error: true }

  const type = asString(entry.type)

  if (type === undefined || type === "message") {
    return messageItem(entry, state)
  }

  if (type === "function_call" || type === "custom_tool_call") {
    const item = functionCallItem(entry)
    return "error" in item ? item : [item]
  }

  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const item = functionCallOutputItem(entry)
    return "error" in item ? item : [item]
  }

  if (type === "reasoning") {
    const item = reasoningReplayItem(entry)
    return item ? [item] : []
  }

  if (type === "item_reference") {
    // Stateless proxy: there is no stored response to reference.
    return { error: true }
  }

  return { error: true }
}

// Same rule as the chat facade: always send the full builtin set (stubbed
// descriptions) first, then the client's own function tools. The Responses
// API tool shape is flat ({type:"function", name, ...}), but clients that
// mistakenly send the chat-nested shape are tolerated. Muse Code sends a
// single {type:"namespace", name:"muse", tools:[...]} wrapper: its inner
// functions are the real client tools and must be unwrapped, otherwise the
// model never sees a callable tool and multi-turn tool loops cannot start.
function flattenNamespaceTools(value: unknown): Array<{ entry: unknown; nsPrefix?: string }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ entry: unknown; nsPrefix?: string }> = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    if (entry.type === "namespace" && Array.isArray(entry.tools)) {
      const prefix = asString(entry.name)
      for (const inner of entry.tools) out.push({ entry: inner, nsPrefix: prefix })
      continue
    }
    out.push({ entry })
  }
  return out
}
function customExecToFunction(entry: Record<string, unknown>): { name: string; description: string; parameters: Record<string, unknown> } | undefined {
  const name = asString(entry.name)
  if (name === undefined || name === "") return undefined
  // codex 线程执行器把文件读写能力挂在顶层 custom/exec 沙箱嵌套工具里，
  // 上游 responses 端点明确拒绝 type=custom（400 "`custom` tools are not
  // supported on this endpoint"，2026-09-29 实测），原样透传必死。
  // 转写为等名 function 工具：模型发起 function_call/exec，本地执行器照常
  // 执行并回传 function_call_output，全链路复用现有 function 回放环。
  // 描述压缩到首段（codex 原描述 16KB，每轮 62KB 重发是长会话中断帮凶之一，
  // 上游 created 回显 tools 全量，68KB 回显挤占首包窗口）。
  const fullDescription = asString(entry.description) ?? ""
  const firstParagraph = fullDescription.split("\n\n")[0] ?? ""
  const nestedHint = "Nested tools are available on the global `tools` object (e.g. await tools.exec_command(...)). File reads go through nested shell commands."
  const description = firstParagraph.length > 0 ? `${firstParagraph} ${nestedHint}` : nestedHint
  return {
    name,
    description: description.slice(0, 2000),
    parameters: {
      type: "object",
      properties: { input: { type: "string", description: "Raw JavaScript source text orchestrating nested tool calls (native exec payload key)" } },
      required: ["input"],
    },
  }
}
function mergeToolsWithBuiltins(value: unknown): { tools: UpstreamTool[]; clientToolNames: Set<string>; nsPrefixByBare: Map<string, string>; customToolNames: Set<string> } {
  const flat = flattenNamespaceTools(value)
  const client: UpstreamTool[] = []
  const names = new Set<string>()
  const nsPrefixByBare = new Map<string, string>()
  const customToolNames = new Set<string>()
  for (const { entry, nsPrefix } of flat) {
    if (!isRecord(entry)) continue
    let name: string | undefined
    let description: string | undefined
    let parameters: Record<string, unknown> | undefined
    let strict: boolean | undefined
    if (entry.type === "function") {
      name = asString(entry.name)
      description = asString(entry.description)
      parameters = isRecord(entry.parameters) ? entry.parameters : undefined
      if (typeof entry.strict === "boolean") strict = entry.strict
      if (name === undefined && isRecord(entry.function)) {
        // Chat-nested shape fallback.
        const fn = entry.function
        name = asString(fn.name)
        description = asString(fn.description) ?? description
        parameters = isRecord(fn.parameters) ? fn.parameters : parameters
        if (typeof fn.strict === "boolean") strict = fn.strict
      }
    } else if (entry.type === "custom" && asString(entry.name) !== undefined) {
      // codex exec 沙箱：转写为同名 function 工具后上行（见上）。
      // 仅收有名字符串的 custom 条目；web_search 等无名服务端工具仍忽略。
      const converted = customExecToFunction(entry)
      if (converted === undefined) continue
      name = converted.name
      description = converted.description
      parameters = converted.parameters
      customToolNames.add(converted.name)
    }
    if (name === undefined) continue
    const tool: UpstreamTool = {
      type: "function",
      name,
      description: description ?? "",
      parameters: parameters ?? { type: "object", properties: {} },
    }
    if (strict !== undefined) tool.strict = strict
    client.push(tool)
    names.add(name)
    if (nsPrefix !== undefined && !nsPrefixByBare.has(name)) nsPrefixByBare.set(name, nsPrefix)
  }
  return { tools: appendClientTools(client), clientToolNames: names, nsPrefixByBare, customToolNames }
}

function clampMaxOutputTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Math.floor(value), MAX_OUTPUT_TOKENS)
}

export interface NormalizeOptions {
  /** opencode session id used as the upstream prompt_cache_key. */
  sessionId?: string
}

export function normalizeResponsesRequest(body: unknown, options: NormalizeOptions = {}): NormalizeResult {
  if (!isRecord(body)) {
    return { error: { status: 400, message: "request body must be a JSON object" } }
  }

  // Stateless proxy: previous_response_id requires server-side storage.
  const previousResponseId = body.previous_response_id
  if (previousResponseId !== undefined && previousResponseId !== null && previousResponseId !== "") {
    return {
      error: {
        status: 400,
        message: "previous_response_id is not supported: this proxy is stateless; send the full conversation in `input` instead",
        code: "previous_response_id_unsupported",
      },
    }
  }

  const state = { systemTexts: [] as string[] }
  const input: UpstreamInputItem[] = []

  const instructions = asString(body.instructions)
  if (instructions !== undefined) state.systemTexts.push(instructions)

  const rawInput = body.input
  if (typeof rawInput === "string") {
    input.push({ role: "user", content: [{ type: "input_text", text: rawInput }] })
  } else if (Array.isArray(rawInput)) {
    for (const entry of rawInput) {
      const items = normalizeInputItem(entry, state)
      if ("error" in items) {
        return { error: { status: 400, message: "unsupported input item", code: "unsupported_input_item" } }
      }
      input.push(...items)
    }
  } else {
    return { error: { status: 400, message: "`input` is required and must be a string or an array of items", code: "missing_input" } }
  }

  const request: UpstreamRequest = {
    model: MODEL_ID,
    input,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: extractEffort(body), summary: "auto" },
  }
  if (options.sessionId) request.prompt_cache_key = options.sessionId

  if (state.systemTexts.length > 0) {
    request.input = [{ role: "system", content: state.systemTexts.join("\n") }, ...request.input]
  }

  // Free-tier fingerprint: full opencode builtin set + client tools;
  // tool_choice is always "auto" upstream (same as the chat facade).
  const merged = mergeToolsWithBuiltins(body.tools)
  request.tools = merged.tools
  request.tool_choice = "auto" as UpstreamToolChoice

  if (typeof body.temperature === "number") request.temperature = body.temperature
  if (typeof body.top_p === "number") request.top_p = body.top_p
  const maxOutputTokens = clampMaxOutputTokens(body.max_output_tokens)
  if (maxOutputTokens !== undefined) request.max_output_tokens = maxOutputTokens

  const wantsStream = body.stream === true
  return { request, stream: wantsStream, clientToolNames: merged.clientToolNames, nsPrefixByBare: merged.nsPrefixByBare, customToolNames: merged.customToolNames }
}
