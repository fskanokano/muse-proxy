// The upstream free-tier gate compares every reserved tool name (the 12
// builtins + the retired `bash`/`task`/`todowrite`) against the real opencode
// definitions, so a client tool may not reuse one. These tests pin the
// workaround: verbatim builtins first, reserved client tools appended under an
// `mp_` alias, alias mapped back when the call is raised to the client.
import { describe, expect, it } from "vitest"
import {
  OPENCODE_BUILTIN_TOOLS,
  appendClientTools,
  exposedToolName,
  shouldExposeToolCall,
} from "../api/_lib/tools"

const clientTool = (name: string) => ({
  type: "function" as const,
  name,
  description: `${name} (client)`,
  parameters: { type: "object" as const, properties: {} },
})

describe("tool aliasing", () => {
  it("ships the builtin set verbatim and appends reserved client tools under mp_ aliases", () => {
    const merged = appendClientTools([clientTool("read"), clientTool("bash"), clientTool("my_tool")])
    expect(merged.slice(0, OPENCODE_BUILTIN_TOOLS.length)).toEqual(OPENCODE_BUILTIN_TOOLS)
    const names = merged.slice(OPENCODE_BUILTIN_TOOLS.length).map((tool) => tool.name)
    expect(names).toEqual(["mp_read", "mp_bash", "my_tool"])
    // The client's own definition survives, only the wire name changes.
    expect(merged.at(-2)!.description).toBe("bash (client)")
    expect(merged.at(-1)!.name).toBe("my_tool")
  })

  it("resolves aliases on the way down", () => {
    expect(exposedToolName("mp_bash")).toBe("bash")
    expect(exposedToolName("mp_read")).toBe("read")
    expect(exposedToolName("bash")).toBe("bash")
    expect(exposedToolName("mp_unknown")).toBe("mp_unknown")
  })

  it("exposes client-executable calls only", () => {
    const pi = new Set(["read", "bash", "edit", "write"])
    expect(shouldExposeToolCall("mp_bash", pi)).toBe(true)
    expect(shouldExposeToolCall("read", pi)).toBe(true)
    expect(shouldExposeToolCall("shell", pi)).toBe(false)
    expect(shouldExposeToolCall("task", new Set())).toBe(false)
    expect(shouldExposeToolCall("mp_task", new Set())).toBe(false)
    expect(shouldExposeToolCall("my_tool", new Set(["my_tool"]))).toBe(true)
  })
})
