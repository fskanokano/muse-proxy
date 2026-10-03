// Encrypted-reasoning replay codec.
//
// opencode zen serves muse-spark over the OpenAI Responses API with
// `store: false` + `include: ["reasoning.encrypted_content"]`. Multi-turn
// reasoning continuity requires replaying the streamed reasoning items
// (id + encrypted_content) back on the next request; items without
// encrypted_content must be dropped entirely or the upstream 400s (see
// opencode packages/llm/src/protocols/openai-responses.ts lowerMessages).
//
// Since standard OpenAI chat clients don't know about reasoning items, we
// smuggle them through the OpenRouter-style `reasoning_details` extension
// field: a base64(JSON) payload of `{ v: 1, items: ReasoningItem[] }`. Any
// agent that echoes assistant messages back verbatim automatically preserves
// full reasoning continuity.

export interface ReasoningItem {
  id: string
  summary: string
  encrypted_content: string
}

const FORMAT_VERSION = 1

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array | undefined {
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return undefined
  }
}

export function encodeReasoningDetails(items: ReasoningItem[]): string {
  const payload = { v: FORMAT_VERSION, items }
  const json = JSON.stringify(payload)
  return bytesToBase64(new TextEncoder().encode(json))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseItem(value: unknown): ReasoningItem | undefined {
  if (!isRecord(value)) return undefined
  const { id, summary, encrypted_content } = value
  if (typeof id !== "string" || id.length === 0) return undefined
  if (typeof encrypted_content !== "string" || encrypted_content.length === 0) return undefined
  if (typeof summary !== "string") return undefined
  return { id, summary, encrypted_content }
}

export function decodeReasoningDetails(raw: unknown): ReasoningItem[] {
  if (typeof raw !== "string" || raw.length === 0) return []
  const bytes = base64ToBytes(raw)
  if (!bytes) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return []
  }
  if (!isRecord(parsed) || parsed.v !== FORMAT_VERSION) return []
  if (!Array.isArray(parsed.items)) return []
  const items: ReasoningItem[] = []
  for (const entry of parsed.items) {
    const item = parseItem(entry)
    if (item) items.push(item)
  }
  return items
}

// Drop items missing encrypted_content (upstream 400s on them when
// store:false) and merge same-id fragments so one logical reasoning item
// (possibly streamed in multiple summary parts) replays as a single input
// item with combined summary text and the final encrypted state.
export function sanitizeReplayItems(items: ReasoningItem[]): ReasoningItem[] {
  const byId = new Map<string, ReasoningItem>()
  for (const item of items) {
    if (typeof item.id !== "string" || item.id.length === 0) continue
    if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) continue
    const existing = byId.get(item.id)
    if (!existing) {
      byId.set(item.id, { id: item.id, summary: item.summary ?? "", encrypted_content: item.encrypted_content })
      continue
    }
    const summaryParts = [existing.summary, item.summary ?? ""].filter((s) => s.length > 0)
    byId.set(item.id, {
      id: item.id,
      summary: summaryParts.join("\n"),
      encrypted_content: item.encrypted_content,
    })
  }
  return [...byId.values()]
}
