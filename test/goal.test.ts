// goal 自动续轮单测 (stub postUpstream, 不碰真上游)。
import { describe, expect, it, vi, beforeEach } from "vitest";
import { runGoalTurns, type GoalCtx, type GoalEvent } from "../supabase/functions/muse-proxy/_lib/goal.ts";
import { MODEL_MUSE, type ModelInfo } from "../supabase/functions/muse-proxy/_lib/types.ts";

const GOAL_MODEL: ModelInfo = {
  id: "muse-spark-1.3-contributor-goal",
  name: "goal",
  upstream: "responses",
  upstreamId: MODEL_MUSE,
  description: "",
  contextWindow: 1,
  maxOutputTokens: 32,
  efforts: [],
  isGoal: true,
};

const TOOLS = [{ type: "function", name: "t", description: "d", parameters: {} }] as GoalCtx["tools"];
const INPUT = [{ role: "user", content: [{ type: "input_text", text: "do it" }] }] as GoalCtx["input"];

function ctxWith(postUpstream: GoalCtx["postUpstream"], maxRounds = 2): GoalCtx {
  return {
    model: GOAL_MODEL,
    baseBody: { model: MODEL_MUSE, stream: true },
    input: INPUT,
    tools: TOOLS,
    maxRounds,
    identity: { sessionId: "ses_x", requestId: "msg_x" },
    postUpstream,
  };
}

async function collect(gen: AsyncGenerator<GoalEvent>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const ev of gen) {
    if (ev !== "done") out.push(ev);
  }
  return out;
}

function sseTurn(text: string, withTools: boolean): GoalEvent[] {
  const evs: GoalEvent[] = [{ type: "response.output_text.delta", delta: text }];
  if (withTools) {
    evs.push({ type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "t", arguments: "{}" } });
  }
  evs.push({ type: "response.completed", response: { usage: null } });
  return evs;
}

async function* gen(evs: GoalEvent[]): AsyncGenerator<GoalEvent> {
  for (const e of evs) yield e;
  yield "done";
}

function judgeBody(verdict: "COMPLETE" | "CONTINUE"): Record<string, unknown> {
  return { output: [{ type: "message", content: [{ type: "output_text", text: verdict === "COMPLETE" ? "COMPLETE" : "CONTINUE because search not done, call web_search next" }] }] };
}

describe("runGoalTurns", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("有工具的干净收尾直接放行, 不判不等 (postUpstream 只调一次首轮之外零次)", async () => {
    const post = vi.fn(async () => new Response("{}", { status: 200 }));
    const out = await collect(runGoalTurns(gen(sseTurn("hi", true)), ctxWith(post)));
    expect(out.filter((e) => e.type === "response.completed")).toHaveLength(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("无工具干净收尾 + judge CONTINUE -> 续一轮, 中间终端被吞, 只放行最终终端", async () => {
    const calls: string[] = [];
    const post = (async (body: Record<string, unknown>) => {
      if ((body as { stream?: boolean }).stream === false) {
        calls.push("judge");
        return new Response(JSON.stringify(judgeBody("CONTINUE")), { status: 200 });
      }
      calls.push("continue");
      // 续轮上游: 带工具的终端流 (goal.ts 会 parseUpstreamSse 解析拼流)
      const sse = `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c9","name":"t","arguments":"{}"}}\n\ndata: {"type":"response.completed","response":{"usage":null}}\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as GoalCtx["postUpstream"];
    const out = await collect(runGoalTurns(gen(sseTurn("status update", false)), ctxWith(post)));
    const terminals = out.filter((e) => e.type === "response.completed");
    expect(terminals).toHaveLength(1); // 中间那个被吞了, 只剩最终
    expect(out.some((e) => (e.item as Record<string, unknown> | undefined)?.type === "function_call")).toBe(true);
    expect(calls).toEqual(["judge", "continue"]);
  });

  it("judge COMPLETE -> 直接放行, 不续轮", async () => {
    const post = vi.fn(async (body: Record<string, unknown>) => {
      if ((body as { stream?: boolean }).stream === false) {
        return new Response(JSON.stringify(judgeBody("COMPLETE")), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const out = await collect(runGoalTurns(gen(sseTurn("all done", false)), ctxWith(post)));
    expect(out.filter((e) => e.type === "response.completed")).toHaveLength(1);
    expect(post.mock.calls.filter((c) => (c[0] as { stream?: boolean }).stream !== false)).toHaveLength(0);
  });

  it("maxRounds=0 时与 muse 行为一致 (不判不续)", async () => {
    const post = vi.fn(async () => new Response("{}", { status: 200 }));
    const out = await collect(runGoalTurns(gen(sseTurn("hi", false)), ctxWith(post, 0)));
    expect(out.filter((e) => e.type === "response.completed")).toHaveLength(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("failed 终端直接透传, 不判不续", async () => {
    const post = vi.fn(async () => new Response("{}", { status: 200 }));
    const out = await collect(runGoalTurns(gen([{ type: "response.failed", response: { error: { message: "x" } } }]), ctxWith(post)));
    expect(out.some((e) => e.type === "response.failed")).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("judge 调用失败 -> fail-closed 直接放行", async () => {
    const post = vi.fn(async () => {
      throw new Error("net down");
    });
    const out = await collect(runGoalTurns(gen(sseTurn("hi", false)), ctxWith(post)));
    expect(out.filter((e) => e.type === "response.completed")).toHaveLength(1);
  });
});
