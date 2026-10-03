// Raise opencode zen upstream Responses SSE events into Anthropic Messages
// API streaming events (message_start / content_block_* / message_delta /
// message_stop / error). Kept separate from raise.ts (chat facade) on
// purpose: the chat completions facade must stay byte-for-byte untouched.
//
// Block state machine: text and thinking deltas lazily open content blocks
// (index-tracked, closed when a different block kind starts or the message
// ends); function calls arrive as complete items on output_item.done and are
// emitted as tool_use blocks with a single input_json_delta.
//
// Terminal guard: if the upstream EOFs without completed/incomplete/failed,
// finish() emits an Anthropic `error` event so clients never mistake a
// truncated stream for a complete message.

import { shouldExposeToolCall } from "./tools.ts"
import type { UpstreamEvent } from "./types.ts"

export interface AnthropicEvent {
  type: string
  [key: string]: unknown
}

export interface MessageRaiserOptions {
  messageId: string
  model: string
  clientToolNames?: ReadonlySet<string>
  toolChoice?: unknown
}

export class MessageRaiser {
  private readonly messageId: string
  private readonly model: string
  private readonly clientToolNames: ReadonlySet<string>
  private readonly toolChoice: unknown
  private index = 0
  private openType: "text" | "thinking" | null = null
  private sawToolUse = false
  private finished = false

  constructor(options: MessageRaiserOptions) {
    this.messageId = options.messageId
    this.model = options.model
    this.clientToolNames = options.clientToolNames ?? new Set<string>()
    this.toolChoice = options.toolChoice
  }

  // Anthropic streams always begin with message_start.
  start(): AnthropicEvent {
    return {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }
  }

  handle(event: UpstreamEvent): AnthropicEvent[] {
    const out: AnthropicEvent[] = []
    if (this.finished) return out

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      const index = this.ensureBlock("text", out)
      out.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: event.delta } })
      return out
    }

    if (
      (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") &&
      typeof event.delta === "string"
    ) {
      const index = this.ensureBlock("thinking", out)
      out.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: event.delta } })
      return out
    }

    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const callId = event.item.call_id ?? event.item.id ?? ""
      const name = event.item.name ?? ""
      if (!this.isExposed(name)) return out
      this.closeBlock(out)
      const args = event.item.arguments ?? "{}"
      const blockIndex = this.index++
      out.push({
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "tool_use", id: callId, name, input: {} },
      })
      out.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: args },
      })
      out.push({ type: "content_block_stop", index: blockIndex })
      this.sawToolUse = true
      return out
    }

    if (event.type === "response.completed" || event.type === "response.incomplete") {
      const usage = event.response?.usage
      const stopReason = event.type === "response.incomplete" ? "max_tokens" : this.sawToolUse ? "tool_use" : "end_turn"
      this.closeBlock(out)
      out.push({
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: usage?.output_tokens ?? 0,
        },
      })
      out.push({ type: "message_stop" })
      this.finished = true
      return out
    }

    if (event.type === "response.failed" || event.type === "error") {
      const code = event.code ?? event.response?.error?.code ?? null
      const message = event.message ?? event.response?.error?.message ?? "unknown upstream error"
      this.closeBlock(out)
      out.push({ type: "error", error: { type: "api_error", message: code ? `${code}: ${message}` : message } })
      this.finished = true
      return out
    }

    return out
  }

  // Called when the upstream stream ends. Emits nothing if a terminal event
  // already completed the message; otherwise surfaces the truncation as an
  // Anthropic error event instead of ending the stream silently.
  finish(): AnthropicEvent[] {
    if (this.finished) return []
    const out: AnthropicEvent[] = []
    this.closeBlock(out)
    out.push({
      type: "error",
      error: {
        type: "api_error",
        message: "upstream_stream_truncated: upstream closed the stream before a terminal event",
      },
    })
    this.finished = true
    return out
  }

  private ensureBlock(type: "text" | "thinking", out: AnthropicEvent[]): number {
    if (this.openType === type) return this.index - 1
    this.closeBlock(out)
    const block = type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" }
    const index = this.index++
    this.openType = type
    out.push({ type: "content_block_start", index, content_block: block })
    return index
  }

  private closeBlock(out: AnthropicEvent[]): void {
    if (this.openType === null) return
    out.push({ type: "content_block_stop", index: this.index - 1 })
    this.openType = null
  }

  private isExposed(name: string): boolean {
    if (this.toolChoice === "none") return false
    if (typeof this.toolChoice === "object" && this.toolChoice !== null && !Array.isArray(this.toolChoice)) {
      const record = this.toolChoice as Record<string, unknown>
      if (record.type === "tool" && typeof record.name === "string") return name === record.name
      if (record.type === "any") return shouldExposeToolCall(name, this.clientToolNames)
      if (record.type === "auto") return shouldExposeToolCall(name, this.clientToolNames)
    }
    return shouldExposeToolCall(name, this.clientToolNames)
  }
}
