// goal 自动续轮单测 (stub postChatUpstream/streamEvents, 不碰真上游)。
// muse 上游因弃用退役后, goal 与所有模型一样走 oa-compat chat/completions
// 流式上游; judge 也必须流式 (门禁: stream:false 一律 403 FreeTierError)。
import { describe, expect, it, vi, beforeEach } from "vitest";
import { runGoalTurns, type GoalCtx, type GoalEvent } from "../supabase/functions/muse-proxy/_lib/goal.ts";
import { lowerChatUpstream } from "../supabase/functions/muse-proxy/_lib/chat-upstream.ts";
import { MODEL_MUSE, type ModelInfo } from "../supabase/functions/muse-proxy/_lib/types.ts";

const GOAL_MODEL: ModelInfo = {
  id: "muse-spark-1.3-contributor-goal",
  name: "goal",
  upstream: "oa-compat",
  upstreamId: "deepseek-v4.1-flash-free",
  description: "",
  contextWindow: 1,
  maxOutputTokens: 32,
  efforts: [],
  isGoal: true,
};

const TOOLS = [{ type: "function", name: "t", description: "d", parameters: {} }] as GoalCtx["tools"];
const INPUT = [{ role: "user", content: [{ type: "input_text", text: "do it" }] }] as GoalCtx["input"];

// baseBody 用真实 lowering 生成, 保证 judge mock 与生产 body 形状一致。
const BASE_BODY = lowerChatUpstream({ model: GOAL_MODEL, input: INPUT, tools: TOOLS, effort: "high" });

async function* raiseChatSse(body: ReadableStream<Uint8Array>): AsyncGenerator<GoalEvent> {
  // 与 OaCompatRaiser 同语义的最小 raise: content/tool_calls/finish ->
  // 规范 Responses 事件 (drainTurn 只消费这三类)。
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const parsed = JSON.parse(payload) as {
        choices?: Array<{
          delta?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
          finish_reason?: string | null;
        }>;
        usage?: unknown;
      };
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      for (const call of delta.tool_calls ?? []) {
        yield {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: call.id ?? "c",
            name: call.function?.name ?? "",
            arguments: call.function?.arguments ?? "",
          },
        };
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { type: "response.output_text.delta", delta: delta.content };
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        yield { type: "response.completed", response: { usage: parsed.usage ?? null } };
        return;
      }
    }
  }
  yield "done";
}

function ctxWith(postChatUpstream: GoalCtx["postChatUpstream"], maxRounds = 2): GoalCtx {
  return {
    model: GOAL_MODEL,
    baseBody: BASE_BODY,
    input: INPUT,
    tools: TOOLS,
    maxRounds,
    identity: { sessionId: "ses_x", requestId: "msg_x" },
    callId: "resp_goal_test",
    created: 123,
    postChatUpstream,
    streamEvents: (body) => raiseChatSse(body),
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

function chatSse(frames: unknown[], withDone = true): Response {
  const lines = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(lines + (withDone ? "data: [DONE]\n\n" : ""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function judgeStreamText(text: string): Response {
  return chatSse([{ choices: [{ index: 0, delta: { content: text } }] }]);
}

function continuationStream(): Response {
  return chatSse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "t", arguments: "{}" } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
}

type PostedBody = {
  isJudge: boolean;
  messages: Array<{ role: string; content?: unknown }>;
  model?: string;
  stream?: boolean;
  prompt_cache_key?: string;
  max_tokens?: number;
  tools?: unknown[];
};

function postSpy(): { calls: PostedBody[]; fn: GoalCtx["postChatUpstream"] } {
  const calls: PostedBody[] = [];
  const fn = (async (body: Record<string, unknown>) => {
    const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
    const isJudge = messages[0]?.role === "system"; // judge 注入 system, 续轮沿用首轮 user 开头
    calls.push({
      isJudge,
      messages,
      model: body.model as string,
      stream: body.stream as boolean,
      prompt_cache_key: body.prompt_cache_key as string,
      max_tokens: body.max_tokens as number,
      tools: body.tools as unknown[],
    });
    if (isJudge) return judgeStreamText("CONTINUE because search not done, call web_search next");
    return continuationStream();
  }) as GoalCtx["postChatUpstream"];
  return { calls, fn };
}

describe("runGoalTurns", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("有工具的干净收尾直接放行, 不判不等 (postChatUpstream 只调一次首轮之外零次)", async () => {
    const post = vi.fn(async () => chatSse([]));
    const out = await collect(runGoalTurns(gen(sseTurn("hi", true)), ctxWith(post)));
    expect(out.filter((e) => e.type === "response.completed")).toHaveLength(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("无工具干净收尾 + judge CONTINUE -> 续一轮, 中间终端被吞, 只放行最终终端", async () => {
    const { calls, fn } = postSpy();
    const out = await collect(runGoalTurns(gen(sseTurn("status update", false)), ctxWith(fn)));
    const terminals = out.filter((e) => e.type === "response.completed");
    expect(terminals).toHaveLength(1); // 中间那个被吞了, 只剩最终
    expect(out.some((e) => (e.item as Record<string, unknown> | undefined)?.type === "function_call")).toBe(true);
    expect(calls.map((c) => (c.isJudge ? "judge" : "continue"))).toEqual(["judge", "continue"]);
    // judge 形状: 流式 (门禁) + 深度别名 + prompt_cache_key + max_tokens + 完整工具集过闸
    const judge = calls[0]!;
    expect(judge.stream).toBe(true);
    expect(judge.model).toBe("deepseek-v4.1-flash-free");
    expect(judge.prompt_cache_key).toBe("ses_x");
    expect(judge.max_tokens).toBe(256);
    expect(judge.tools).toHaveLength(TOOLS.length);
    // 续轮: 沿用首轮 body 结果 + assistant 文本 + user nudge
    const continuation = calls[1]!;
    expect(continuation.messages).toHaveLength(BASE_BODY.messages.length + 2);
    expect((continuation.messages.at(-2) as { content: string }).content).toBe("status update");
    expect(String((continuation.messages.at(-1) as { content?: string }).content)).toContain("call web_search");
  });

  it("judge COMPLETE -> 直接放行, 不续轮", async () => {
    const post = vi.fn(async () => judgeStreamText("COMPLETE"));
    const out = await collect(runGoalTurns(gen(sseTurn("all done", false)), ctxWith(post)));
    expect(out.filter((e) => e.type === "response.completed")).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(1); // 只发 judge 请求, 无续轮
  });

  it("maxRounds=0 时与非 goal 模型行为一致 (不判不续)", async () => {
    const post = vi.fn(async () => chatSse([]));
    const out = await collect(runGoalTurns(gen(sseTurn("hi", false)), ctxWith(post, 0)));
    expect(out.filter((e) => e.type === "response.completed")).toHaveLength(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("failed 终端直接透传, 不判不续", async () => {
    const post = vi.fn(async () => chatSse([]));
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
    expect(out.some((e) => e.type === "error")).toBe(false);
  });

  it("续轮 POST 拒绝 -> 透传 error 事件收尾 (不进入下一轮)", async () => {
    const calls: PostedBody[] = [];
    const fn = (async (body: Record<string, unknown>) => {
      const messages = (body.messages ?? []) as Array<{ role: string }>;
      const isJudge = messages[0]?.role === "system";
      calls.push({ isJudge, messages });
      if (isJudge) return judgeStreamText("CONTINUE keep going");
      return new Response(JSON.stringify({ error: { message: "knife" } }), { status: 500 });
    }) as GoalCtx["postChatUpstream"];
    const out = await collect(runGoalTurns(gen(sseTurn("half", false)), ctxWith(fn)));
    expect(out.some((e) => e.type === "error" && e.code === "upstream_500")).toBe(true);
    expect(calls.filter((c) => !c.isJudge)).toHaveLength(1);
  });
});
