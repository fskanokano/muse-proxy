import { describe, expect, it } from "vitest"
import { checkAuth } from "../api/_lib/auth"

function req(headers: Record<string, string>): Request {
  return new Request("https://proxy.example/v1/chat/completions", { headers })
}

describe("checkAuth", () => {
  const env = { PROXY_API_KEY: "s3cret-key" }

  it("accepts a correct bearer token", () => {
    expect(checkAuth(req({ authorization: "Bearer s3cret-key" }), env)).toBe(true)
  })

  it("accepts a correct x-api-key", () => {
    expect(checkAuth(req({ "x-api-key": "s3cret-key" }), env)).toBe(true)
  })

  it("rejects a wrong key", () => {
    expect(checkAuth(req({ authorization: "Bearer wrong" }), env)).toBe(false)
  })

  it("rejects same-length but different keys", () => {
    expect(checkAuth(req({ authorization: "Bearer s3cret-keY" }), env)).toBe(false)
  })

  it("rejects a key that is a prefix of the real key", () => {
    expect(checkAuth(req({ authorization: "Bearer s3cret" }), env)).toBe(false)
  })

  it("rejects when no credentials are provided", () => {
    expect(checkAuth(req({}), env)).toBe(false)
  })

  it("rejects everything when PROXY_API_KEY is unset", () => {
    expect(checkAuth(req({ authorization: "Bearer s3cret-key" }), {})).toBe(false)
    expect(checkAuth(req({ authorization: "Bearer s3cret-key" }), { PROXY_API_KEY: "" })).toBe(false)
  })

  it("rejects a non-bearer authorization header", () => {
    expect(checkAuth(req({ authorization: "Basic s3cret-key" }), env)).toBe(false)
  })
})
