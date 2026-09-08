// SSE helpers: render chat chunks as `data: {...}` lines with keepalive
// comments, plus an upstream SSE line parser for the Responses event stream.

import type { ChatChunk } from "./types"

export const HEARTBEAT_COMMENT = ": ping\n\n"
export const HEARTBEAT_INTERVAL_MS = 15_000
export const DONE_LINE = "data: [DONE]\n\n"

export function chunkToSse(chunk: ChatChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

// Parse an upstream SSE byte stream into JSON event objects.
// SSE events are separated by blank lines; a `data:` group may span multiple
// lines (joined with \n). `data: [DONE]` maps to the "done" sentinel.
export async function* parseUpstreamSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown> | "done"> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let dataLines: string[] = []

  const flush = (): Record<string, unknown> | "done" | undefined => {
    if (dataLines.length === 0) return undefined
    const data = dataLines.join("\n")
    dataLines = []
    if (data === "[DONE]") return "done"
    try {
      const parsed = JSON.parse(data) as unknown
      if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>
      return undefined
    } catch {
      return undefined
    }
  }

  const processLine = (line: string): Record<string, unknown> | "done" | undefined => {
    if (line === "" || line === "\r") {
      // blank line terminates the current event
      return flush()
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^\s/, "").replace(/\r$/, ""))
      return undefined
    }
    // comments (: ...) and other fields (event:, id:, retry:) are ignored
    return undefined
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      const event = processLine(line)
      if (event !== undefined) yield event
    }
  }
  // flush any trailing line without newline
  if (buffer.length > 0) {
    const event = processLine(buffer)
    if (event !== undefined) yield event
  }
  const tail = flush()
  if (tail !== undefined) yield tail
  yield "done"
}
