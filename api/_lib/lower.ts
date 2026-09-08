// Lower an OpenAI Chat Completions request body into an opencode zen
// Responses API request. Mirrors opencode's own lowering rules for muse
// models: store:false, include encrypted reasoning, reasoning summary auto,
// effort whitelisting, and replay-item sanitization.

import { decodeReasoningDetails, sanitizeReplayItems, type ReasoningItem } from "./reasoning"
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
} from "./types"

export type LowerResult =
  | { request: UpstreamRequest }
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

function extractEffort(chat: Record<string, unknown>): ReasoningEffort {
  if (chat.reasoning_effort !== undefined) return normalizeEffort(chat.reasoning_effort)
  if (isRecord(chat.reasoning) && chat.reasoning.effort !== undefined) {
    return normalizeEffort(chat.reasoning.effort)
  }
  return DEFAULT_REASONING_EFFORT
}

function imageToDataUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (isRecord(value) && typeof value.url === "string") return value.url
  return undefined
}

function userContentParts(content: unknown): UpstreamInputItem[] | { error: true } {
  const parts: UpstreamInputItem extends never ? never : Array<
    { type: "input_text"; text: string } | { type: "input_image"; image_url: string }
  > = []

  const pushText = (text: string) => parts.push({ type: "input_text", text })
  const pushImage = (url: string) => parts.push({ type: "input_image", image_url: url })

  if (typeof content === "string") {
    pushText(content)
    return [{ role: "user", content: parts } as UpstreamInputItem]
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) return { error: true }
      if (part.type === "text" && typeof part.text === "string") {
        pushText(part.text)
        continue
      }
      if (part.type === "image_url") {
        const url = imageToDataUrl(part.image_url)
        if (url === undefined) return { error: true }
        pushImage(url)
        continue
      }
      return { error: true }
    }
    if (parts.length === 0) return { error: true }
    return [{ role: "user", content: parts } as UpstreamInputItem]
  }

  return { error: true }
}

// OpenRouter-style reasoning_details may also arrive as a custom array (from
// gateways with their own format). We can't interpret those safely, so we
// ignore them — reasoning continuity then degrades gracefully instead of
// failing the request upstream.
function replayItemsFromAssistant(message: Record<string, unknown>): ReasoningItem[] {
  const raw = message.reasoning_details
  if (typeof raw !== "string") return []
  return sanitizeReplayItems(decodeReasoningDetails(raw))
}

function reasoningInputItems(items: ReasoningItem[]): UpstreamInputItem[] {
  return items.map((item) => ({
    type: "reasoning" as const,
    id: item.id,
    summary:
      item.summary.length > 0 ? [{ type: "summary_text" as const, text: item.summary }] : [],
    encrypted_content: item.encrypted_content,
  }))
}

function toolCallItems(message: Record<string, unknown>): UpstreamInputItem[] | { error: true } {
  const calls = message.tool_calls
  if (calls === undefined || calls === null) return []
  if (!Array.isArray(calls)) return { error: true }
  const items: UpstreamInputItem[] = []
  for (const call of calls) {
    if (!isRecord(call)) return { error: true }
    const fn = isRecord(call.function) ? call.function : undefined
    const id = asString(call.id)
    const name = asString(fn?.name)
    if (id === undefined || name === undefined) return { error: true }
    const args = asString(fn?.arguments) ?? "{}"
    items.push({ type: "function_call", call_id: id, name, arguments: args })
  }
  return items
}

function toolResultItem(message: Record<string, unknown>): UpstreamInputItem | { error: true } {
  const callId = asString(message.tool_call_id)
  if (callId === undefined) return { error: true }
  const content = message.content
  let output: string
  if (typeof content === "string") {
    output = content
  } else if (Array.isArray(content)) {
    output = content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("")
  } else if (isRecord(content) || typeof content === "number" || typeof content === "boolean") {
    output = JSON.stringify(content)
  } else if (content === undefined || content === null) {
    output = ""
  } else {
    return { error: true }
  }
  return { type: "function_call_output", call_id: callId, output }
}

function toolChoice(value: unknown): UpstreamToolChoice | undefined {
  if (value === "auto" || value === "none" || value === "required") return value
  if (isRecord(value) && value.type === "function") {
    const fn = isRecord(value.function) ? value.function : undefined
    const name = asString(fn?.name)
    if (name !== undefined) return { type: "function", name }
  }
  return undefined
}

function lowerTools(value: unknown): UpstreamTool[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return undefined
  const tools: UpstreamTool[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const fn = isRecord(entry.function) ? entry.function : undefined
    const name = asString(fn?.name)
    if (name === undefined) continue
    const parameters =
      isRecord(fn?.parameters) ? fn.parameters : { type: "object", properties: {} }
    tools.push({
      type: "function",
      name,
      description: asString(fn?.description) ?? "",
      parameters,
    })
  }
  return tools.length > 0 ? tools : undefined
}

function clampMaxOutputTokens(chat: Record<string, unknown>): number | undefined {
  const raw = chat.max_completion_tokens ?? chat.max_tokens
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined
  return Math.min(Math.floor(raw), MAX_OUTPUT_TOKENS)
}

export function lowerRequest(chat: unknown): LowerResult {
  if (!isRecord(chat)) {
    return { error: { status: 400, message: "request body must be a JSON object" } }
  }
  const messages = chat.messages
  if (!Array.isArray(messages)) {
    return { error: { status: 400, message: "`messages` must be an array", code: "missing_messages" } }
  }

  const input: UpstreamInputItem[] = []
  const systemTexts: string[] = []

  for (const entry of messages) {
    if (!isRecord(entry)) {
      return { error: { status: 400, message: "each message must be an object" } }
    }
    const role = entry.role
    if (role === "system" || role === "developer") {
      if (role === "developer") {
        // OpenAI's developer role is a system instruction; accept it.
      }
      const text = typeof entry.content === "string" ? entry.content : undefined
      if (text === undefined) {
        return { error: { status: 400, message: "system message content must be a string" } }
      }
      systemTexts.push(text)
      continue
    }

    if (role === "user") {
      const parts = userContentParts(entry.content)
      if ("error" in parts) {
        return { error: { status: 400, message: "unsupported user message content" } }
      }
      input.push(...(parts as UpstreamInputItem[]))
      continue
    }

    if (role === "assistant") {
      input.push(...reasoningInputItems(replayItemsFromAssistant(entry)))
      const text = typeof entry.content === "string" ? entry.content : undefined
      if (text !== undefined && text.length > 0) {
        input.push({ role: "assistant", content: [{ type: "output_text", text }] })
      }
      const calls = toolCallItems(entry)
      if ("error" in calls) {
        return { error: { status: 400, message: "unsupported tool_calls shape" } }
      }
      input.push(...calls)
      continue
    }

    if (role === "tool") {
      const item = toolResultItem(entry)
      if ("error" in item) {
        return { error: { status: 400, message: "tool message requires tool_call_id and content" } }
      }
      input.push(item)
      continue
    }

    return { error: { status: 400, message: `unsupported message role: ${String(role)}` } }
  }

  const request: UpstreamRequest = {
    model: MODEL_ID,
    input,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: extractEffort(chat), summary: "auto" },
  }

  if (systemTexts.length > 0) {
    request.input = [{ role: "system", content: systemTexts.join("\n") }, ...request.input]
  }

  const tools = lowerTools(chat.tools)
  if (tools) request.tools = tools
  const toolChoiceValue = toolChoice(chat.tool_choice)
  if (toolChoiceValue !== undefined) request.tool_choice = toolChoiceValue

  if (typeof chat.temperature === "number") request.temperature = chat.temperature
  if (typeof chat.top_p === "number") request.top_p = chat.top_p
  const maxOutputTokens = clampMaxOutputTokens(chat)
  if (maxOutputTokens !== undefined) request.max_output_tokens = maxOutputTokens

  return { request }
}
