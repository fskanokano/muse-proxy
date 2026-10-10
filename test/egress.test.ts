// 动态出口选择纯函数测试 (不碰网络/磁盘)。
import { describe, expect, it, beforeEach } from "vitest";
import { pickEgress, resetRoundRobin, type Discovery } from "../server/egress.js";

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
