// 限流换出口重试 (独立文件: doMock 会污染模块注册表, 与主文件隔离)。
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.doMock("../server/http-fetch.js", () => {
  const seen: string[] = [];
  (globalThis as Record<string, unknown>).__retrySeen = seen;
  const ok = (status: number) => new Response("{}", { status, headers: { "content-type": "application/json" } });
  return {
    nodeHttpFetch: async () => ok(429),
    fetchWithEgress:
      (ip: string) =>
      (async (url: string) => {
        seen.push(`${ip}:${url}`);
        return ok(seen.length === 1 ? 429 : 200);
      }) as typeof fetch,
  };
});

const { createRequestFetcher, resetRoundRobin } = await import("../server/egress.js");
import type { Discovery } from "../server/egress.js";

const found: Discovery = {
  def: { ip: "10.0.0.114", name: "main", public_ip: "129.225.150.203" },
  secondaries: [
    { ip: "10.0.0.91", name: "egress91", public_ip: "140.83.51.97", usable: true },
    { ip: "10.0.0.161", name: "egress161", public_ip: "152.70.82.176", usable: true },
  ],
  updated_at: Date.now(),
};

describe("限流换出口重试", () => {
  beforeEach(() => resetRoundRobin());

  it("secondary 的 429 换出口重打, 日志记第二次出口", async () => {
    const { fetchImpl, getEgress } = createRequestFetcher("secondary", [], found);
    const res = await fetchImpl("https://opencode.ai/zen/v1/responses", { method: "POST" });
    const seen = (globalThis as Record<string, unknown>).__retrySeen as string[];
    expect(res.status).toBe(200);
    expect(seen.length).toBe(2);
    expect(new Set(seen.map((s) => s.split(":")[0])).size).toBe(2);
    expect(getEgress()?.ip).not.toBe("default");
  });
});
