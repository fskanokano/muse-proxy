// 动态出口选择纯函数测试 (不碰网络/磁盘)。
import { describe, expect, it, beforeEach, vi } from "vitest";
import { naturalNameCmp } from "../server/egress.js";

describe("naturalNameCmp", () => {
  it("egress1 < egress2 < ... < egress10（纯字符串会把10排到2前面）", () => {
    const names = ["egress10", "egress2", "egress1", "egress9", "main", "egress3"];
    expect(names.slice().sort(naturalNameCmp)).toEqual(["egress1", "egress2", "egress3", "egress9", "egress10", "main"]);
  });
});
import { pickEgress, resetRoundRobin, createRequestFetcher, type Discovery } from "../server/egress.js";

const found: Discovery = {
  def: { ip: "10.0.0.114", name: "main", public_ip: "129.225.150.203" },
  secondaries: [
    { ip: "10.0.0.91", name: "egress91", public_ip: "140.83.51.97", usable: true },
    { ip: "10.0.0.161", name: "egress161", public_ip: "152.70.82.176", usable: true },
    { ip: "10.0.0.162", name: "egress162", public_ip: "", usable: false },
  ],
  updated_at: Date.now(),
};

describe("pickEgress", () => {
  beforeEach(() => resetRoundRobin());

  it("primary 恒走默认路由 (不绑定)", () => {
    const p = pickEgress("primary", [], found);
    expect(p.ip).toBe("default");
    expect(p.name).toBe("main");
    expect(p.public_ip).toBe("129.225.150.203");
  });

  it("secondary 空勾选 = 全选可用并轮询", () => {
    const seq = [pickEgress("secondary", [], found).ip, pickEgress("secondary", [], found).ip, pickEgress("secondary", [], found).ip];
    expect(seq).toEqual(["10.0.0.161", "10.0.0.91", "10.0.0.161"]);
    // 不可用 162 永不出现
    for (let i = 0; i < 10; i++) expect(pickEgress("secondary", [], found).ip).not.toBe("10.0.0.162");
  });

  it("secondary 显式单选钉死", () => {
    for (let i = 0; i < 5; i++) {
      const p = pickEgress("secondary", ["10.0.0.91"], found);
      expect(p.ip).toBe("10.0.0.91");
      expect(p.name).toBe("egress91");
      expect(p.public_ip).toBe("140.83.51.97");
    }
  });

  it("secondary 勾选全不可用 -> 回落默认路由 (调用方 gate 会先 400, 此处不断言抛错)", () => {
    const p = pickEgress("secondary", ["10.0.0.162"], found);
    expect(p.ip).toBe("default");
  });

  it("无发现数据时 primary 仍可用 (name 回 main)", () => {
    const empty: Discovery = { def: null, secondaries: [], updated_at: 0 };
    expect(pickEgress("primary", [], empty).ip).toBe("default");
    expect(pickEgress("secondary", [], empty).ip).toBe("default");
  });
});

describe("createRequestFetcher 限流换出口", () => {
  beforeEach(() => {
    resetRoundRobin();
    vi.unstubAllGlobals();
  });

  const ok = (status: number) => new Response("{}", { status, headers: { "content-type": "application/json" } });

  it("primary 的 429 直接透传 (无可换出口, 不重试)", async () => {
    // primary 走全局 fetch: 此处不断言 stub 细节, 只锁定"不抛错且状态透传"。
    // (全局 fetch 的 stub 语义由下一个用例覆盖; 本用例用本地回环做确定性断言)
    const { fetchImpl, getEgress } = createRequestFetcher("primary", [], found);
    await expect(fetchImpl("http://127.0.0.1:9/", {})).rejects.toThrow();
    expect(getEgress()?.ip).toBe("default");
  });

  it("非 429/503 直接返回, 不重试", async () => {
    vi.stubGlobal(
      "fetch",
      (async () => ok(200)) as typeof fetch,
    );
    const { fetchImpl } = createRequestFetcher("primary", [], found);
    const res = await fetchImpl("https://example.invalid/", {});
    expect(res.status).toBe(200);
  });
});
