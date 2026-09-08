import { describe, expect, it } from "vitest"
import { decodeReasoningDetails, encodeReasoningDetails, sanitizeReplayItems } from "../api/_lib/reasoning"

const item = (id: string, encrypted: string, summary = "") => ({ id, encrypted_content: encrypted, summary })

describe("encodeReasoningDetails / decodeReasoningDetails", () => {
  it("round-trips items", () => {
    const items = [item("rs_1", "enc-abc", "thinking...")]
    const encoded = encodeReasoningDetails(items)
    expect(typeof encoded).toBe("string")
    expect(decodeReasoningDetails(encoded)).toEqual(items)
  })

  it("handles unicode summaries", () => {
    const items = [item("rs_中文", "enc-加密", "思考中…🤔")]
    expect(decodeReasoningDetails(encodeReasoningDetails(items))).toEqual(items)
  })

  it("returns [] for garbage input", () => {
    expect(decodeReasoningDetails("not-base64!!!")).toEqual([])
    expect(decodeReasoningDetails(42)).toEqual([])
    expect(decodeReasoningDetails(null)).toEqual([])
    expect(decodeReasoningDetails(undefined)).toEqual([])
    expect(decodeReasoningDetails("")).toEqual([])
  })

  it("returns [] for valid base64 of wrong shape", () => {
    const wrong = btoa(JSON.stringify({ v: 2, items: [] }))
    expect(decodeReasoningDetails(wrong)).toEqual([])
    const noItems = btoa(JSON.stringify({ v: 1 }))
    expect(decodeReasoningDetails(noItems)).toEqual([])
  })

  it("drops malformed items inside a valid payload", () => {
    const payload = {
      v: 1,
      items: [
        item("rs_ok", "enc"),
        { id: "", encrypted_content: "x", summary: "" },
        { id: "rs_noid", summary: "" },
        null,
        "string",
      ],
    }
    const decoded = decodeReasoningDetails(btoa(JSON.stringify(payload)))
    expect(decoded).toEqual([item("rs_ok", "enc")])
  })
})

describe("sanitizeReplayItems", () => {
  it("keeps only items with string encrypted_content", () => {
    const input = [
      item("a", "enc-a"),
      { id: "b", encrypted_content: null, summary: "s" },
      { id: "c", summary: "s" },
    ]
    expect(sanitizeReplayItems(input as never)).toEqual([item("a", "enc-a")])
  })

  it("merges same-id items keeping last encrypted_content and joining summaries", () => {
    const input = [
      item("a", "enc-1", "part one"),
      item("a", "enc-2", "part two"),
      item("b", "enc-b", "other"),
    ]
    const result = sanitizeReplayItems(input)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(item("a", "enc-2", "part one\npart two"))
    expect(result[1]).toEqual(item("b", "enc-b", "other"))
  })

  it("rejects non-string ids", () => {
    const input = [{ id: 5, encrypted_content: "x", summary: "" }]
    expect(sanitizeReplayItems(input as never)).toEqual([])
  })
})
