// Shared usage mapping between the raising path (streaming chunks) and the
// aggregation path (non-streaming completions).

import type { ChatUsage, UpstreamUsage } from "./types"

export function usageToChat(usage: UpstreamUsage | null | undefined): ChatUsage | undefined {
  if (!usage) return undefined
  const promptTokens = usage.input_tokens ?? 0
  const completionTokens = usage.output_tokens ?? 0
  const chat: ChatUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
  }
  if (usage.input_tokens_details?.cached_tokens !== undefined && usage.input_tokens_details !== null) {
    chat.prompt_tokens_details = { cached_tokens: usage.input_tokens_details.cached_tokens }
  }
  if (usage.output_tokens_details?.reasoning_tokens !== undefined && usage.output_tokens_details !== null) {
    chat.completion_tokens_details = { reasoning_tokens: usage.output_tokens_details.reasoning_tokens }
  }
  return chat
}
