// Raise opencode zen Responses API SSE events into OpenAI chat.completion
// chunks. Pure transform: the caller (chat.ts) owns the SSE wire format,
// heartbeats, and non-stream aggregation.

import { encodeReasoningDetails, type ReasoningItem } from "./reasoning"
import type { ChatChunk, ChatUsage, UpstreamEvent } from "./types"
import { usageToChat } from "./usage"

export interface RaiserOptions {
  id: string
  created: number
  model: string
}

export interface Raiser {
  handle: (event: UpstreamEvent) => ChatChunk[]
  finish: () => ChatChunk[]
}

interface RaiserState {
  toolCallCount: number
  sawToolCalls: boolean
  finished: boolean
}

const EMPTY_DELTA = {}

function chunk(
  options: RaiserOptions,
  delta: ChatChunk["choices"][number]["delta"],
  finishReason: string | null = null,
  usage?: ChatUsage,
): ChatChunk {
  const out: ChatChunk = {
    id: options.id,
    object: "chat.completion.chunk",
    created: options.created,
    model: options.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  if (usage) out.usage = usage
  return out
}

export function createRaiser(options: RaiserOptions): Raiser {
  const state: RaiserState = { toolCallCount: 0, sawToolCalls: false, finished: false }

  const emitFinish = (finishReason: string, usage?: ChatUsage): ChatChunk[] => {
    if (state.finished) return []
    state.finished = true
    const c = chunk(options, EMPTY_DELTA, finishReason, usage)
    return [c]
  }

  const handleItemDone = (item: NonNullable<UpstreamEvent["item"]>): ChatChunk[] => {
    if (item.type === "reasoning") {
      // Only items with encrypted state can be replayed; mirror opencode's
      // store:false filter.
      if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) return []
      const reasoningItem: ReasoningItem = {
        id: item.id ?? "",
        summary: (item.summary ?? [])
          .map((part) => part.text)
          .filter((text) => typeof text === "string")
          .join("\n"),
        encrypted_content: item.encrypted_content,
      }
      if (reasoningItem.id.length === 0) return []
      return [
        chunk(options, {
          reasoning_details: encodeReasoningDetails([reasoningItem]),
        }),
      ]
    }

    if (item.type === "function_call") {
      const callId = item.call_id ?? item.id
      if (!callId || !item.name) return []
      const index = state.toolCallCount++
      state.sawToolCalls = true
      return [
        chunk(options, {
          tool_calls: [
            {
              index,
              id: callId,
              type: "function",
              function: { name: item.name, arguments: item.arguments ?? "" },
            },
          ],
        }),
      ]
    }

    return []
  }

  const handle = (event: UpstreamEvent): ChatChunk[] => {
    if (state.finished) return []

    switch (event.type) {
      case "response.output_text.delta": {
        if (typeof event.delta !== "string" || event.delta.length === 0) return []
        return [chunk(options, { content: event.delta })]
      }

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (typeof event.delta !== "string" || event.delta.length === 0) return []
        return [chunk(options, { reasoning_content: event.delta })]
      }

      case "response.output_item.done": {
        if (!event.item) return []
        return handleItemDone(event.item)
      }

      case "response.completed": {
        const usage = usageToChat(event.response?.usage)
        return emitFinish(state.sawToolCalls ? "tool_calls" : "stop", usage)
      }

      case "response.incomplete": {
        const usage = usageToChat(event.response?.usage)
        return emitFinish("length", usage)
      }

      case "response.failed":
      case "error": {
        const code = event.code ?? event.response?.error?.code ?? undefined
        const message = event.message ?? event.response?.error?.message ?? "unknown upstream error"
        const text = code ? `${code}: ${message}` : message
        const errorNotice = chunk(options, {
          content: `[muse-proxy upstream error] ${text}`,
        })
        return [errorNotice]
      }

      default:
        return []
    }
  }

  return { handle, finish: () => emitFinish(state.sawToolCalls ? "tool_calls" : "stop") }
}
