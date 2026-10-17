// 代理层 goal 自动续轮 (实验: 仅 muse-spark-1.3-contributor-goal 模型触发)。
//
// 触发条件 (必须同时满足, 缺一即原样放行):
//  1. 上游以终端事件干净收尾 (completed; incomplete/failed/error 照常透传, 不干预);
//  2. 本轮零工具调用, 但请求里带了 tools (无 tools 的请求如标题生成天然豁免);
//  3. 未超续轮上限 (MP_GOAL_MAX_ROUNDS, 默认 1000, 0 = 与非 goal 模型行为完全一致);
//  4. judge 判 CONTINUE (裁判即当前模型自身; 判 COMPLETE/判读失败/调用失败一律收尾)。
//
// 上游形态 (2026-10-17 起): muse 的 /responses 上游因弃用退役, goal 与 base
// 模型一致走 oa-compat chat/completions 流式上游 (_lib/oa-compat.ts 注入闭包)。
// 门禁要求上游 stream:true (stream:false 直接 403 FreeTierError), 所以 judge
// 也走流式, 在本地聚合出纯文本后判 COMPLETE/CONTINUE。续轮做法:
// 门面已 lower 好的 chat body 消息数组 + 本轮 assistant 文本 + user nudge,
// 重新 POST (stream:true), 事件经同一 raise 层拼回同一条下游流 (中间终端
// 事件全部吞掉, 只放行最终终端, 各门面自带的截断守卫因此不受影响)。
// usage 只反映最后一轮, 见 README。
//
// 终止性审计 (每条路都通向 return):
//  failed/error/incomplete 终端 -> 直接透传收尾; "done" 无终端 -> 收尾 (门面守卫兜底);
//  有工具/无tools可供/超cap/judge COMPLETE(含一切失败) -> 放行收尾;
//  每次 CONTINUE 消耗一轮 cap, cap 耗尽即收尾。单客户端请求的上游调用数
//  上界 = 1 + cap*(judge + continuation), 默认 cap=1000 (实际受网关超时与成本约束先到)。

import { lowerChatUpstream, type ChatUpstreamRequest } from "./chat-upstream.ts"
import type { ModelInfo, UpstreamInputItem, UpstreamTool } from "./types.ts";

export type GoalEvent = Record<string, unknown> | "done";

export interface GoalIdentity {
  sessionId: string;
  requestId: string;
}

export interface GoalCtx {
  model: ModelInfo;
  /** 首轮已 lower 好的 oa-compat 上游 body (stream:true, 含 tools/reasoning; 续轮只换 messages)。 */
  baseBody: ChatUpstreamRequest;
  /** 门面 lowered 的 input (responses 形状, judge 提取任务文案用)。 */
  input: UpstreamInputItem[];
  tools: UpstreamTool[];
  /** 最多续轮数 (MP_GOAL_MAX_ROUNDS, 0-1000, 缺省 1000, 0 = 与非 goal 行为完全一致)。 */
  maxRounds: number;
  identity: GoalIdentity;
  /** 门面响应 id (chatcmpl/resp_/msg_), 续轮 raise 沿用以保持下游一致性。 */
  callId: string;
  created: number;
  signal?: AbortSignal;
  /** 发往 oa-compat 上游的原始 POST (闭包, 自带指纹头/signal)。 */
  postChatUpstream: (body: ChatUpstreamRequest | Record<string, unknown>) => Promise<Response>;
  /** 续轮事件流: oa-compat SSE -> 规范 Responses 事件 (同 facade id 的新 raiser)。 */
  streamEvents: (body: ReadableStream<Uint8Array>) => AsyncGenerator<GoalEvent>;
}

const JUDGE_SYSTEM =
  "You are a strict task-completion judge for an AI coding agent session. " +
  "Decide ONLY whether the user's goal is fully achieved. " +
  "Reply with exactly COMPLETE if fully achieved, otherwise reply with exactly CONTINUE " +
  "followed by one sentence: what remains unfinished and which tool should be called next. " +
  "No other text.";

const MAX_TASK_CHARS = 1500;
const MAX_TURN_CHARS = 2000;

function firstUserText(input: UpstreamInputItem[]): string {
  for (const item of input) {
    if (typeof item !== "object" || item === null || !("role" in item) || item.role !== "user") continue;
    const content = (item as { content?: unknown }).content;
    if (typeof content === "string") return content.slice(0, MAX_TASK_CHARS);
    if (Array.isArray(content)) {
      const text = content
        .map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as { text?: unknown }).text ?? "") : ""))
        .join("\n");
      if (text.trim()) return text.slice(0, MAX_TASK_CHARS);
    }
  }
  return "(no user text found)";
}

// oa-compat SSE -> 纯文本聚合 (judge 用; 忽略 delta.reasoning_* 与 tool_calls)。
async function judgeTextFromBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).replace(/^\s/, "").replace(/\r$/, "");
      if (payload.length === 0 || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } ; message?: { content?: unknown } }> };
        const choice = chunk.choices?.[0];
        const content = choice?.delta?.content ?? choice?.message?.content;
        if (typeof content === "string") out += content;
      } catch {
        /* non-JSON frame */
      }
      if (out.length > 4096) break outer;
    }
  }
  reader.cancel().catch(() => {});
  return out;
}

type Verdict = { verdict: "complete" | "continue"; reason: string };

async function judgeTurn(ctx: GoalCtx, turnText: string): Promise<Verdict> {
  const done = (verdict: Verdict["verdict"], reason: string): Verdict => {
    console.info(`[goal] judge -> ${verdict}${reason ? ` (${reason.slice(0, 120)})` : ""}`);
    return { verdict, reason };
  };
  const task = firstUserText(ctx.input);
  // Free tier 门禁: 上游必须 stream:true (stream:false 一律 403 FreeTierError)。
  // 下发完整内置工具集过闸, reasoning_effort 不发 (base 模型只认文档档位)。
  const judgeBody: Record<string, unknown> = {
    ...lowerChatUpstream({
      model: ctx.model,
      input: [
        { role: "system", content: JUDGE_SYSTEM },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `TASK: ${task}\n` +
                `ASSISTANT LAST TURN: ${(turnText || "(empty)").slice(0, MAX_TURN_CHARS)}\n` +
                `TOOLS AVAILABLE: ${ctx.tools.length}, TOOLS USED THIS TURN: 0`,
            },
          ],
        },
      ],
      tools: ctx.tools,
      maxOutputTokens: 256,
    }),
    prompt_cache_key: ctx.identity.sessionId,
  };
  let res: Response;
  try {
    res = await ctx.postChatUpstream(judgeBody);
  } catch (e) {
    return done("complete", `judge request failed: ${(e as Error)?.message ?? e}`);
  }
  if (!res.ok) {
    await res.text().catch(() => "");
    return done("complete", `judge upstream status ${res.status}`);
  }
  let text = "";
  try {
    text = await judgeTextFromBody(res.body);
  } catch {
    return done("complete", "judge response unparseable");
  }
  const m = /^\s*(COMPLETE|CONTINUE)\b/i.exec(text);
  if (!m) return done("complete", "judge verdict unparseable");
  if (m[1]!.toUpperCase() === "COMPLETE") return done("complete", "");
  const reason = text.slice(m[0].length).trim().replace(/\s+/g, " ").slice(0, 500) || "judge requested continuation";
  return done("continue", reason);
}

function errorEvent(status: number, message: string): Record<string, unknown> {
  return { type: "error", code: `upstream_${status}`, message };
}

interface TurnSummary {
  sawTools: boolean;
  text: string;
  terminal: string | null;
  stashed: Record<string, unknown> | null;
}

/**
 * 消费一轮事件流: 逐个透传, 终端事件暂存不发, 返回本轮摘要。
 * incomplete/failed/error 直接透传 (调用方收尾); "done" 无终端则静默结束。
 */
async function* drainTurn(
  gen: AsyncGenerator<GoalEvent>,
): AsyncGenerator<GoalEvent, TurnSummary, void> {
  let sawTools = false;
  let text = "";
  let terminal: string | null = null;
  let stashed: Record<string, unknown> | null = null;
  for await (const ev of gen) {
    if (ev === "done") break;
    const t = typeof ev.type === "string" ? ev.type : "";
    if (t === "response.completed") {
      terminal = "completed";
      stashed = ev;
      break;
    }
    if (t === "response.incomplete" || t === "response.failed" || t === "error") {
      yield ev;
      return { sawTools, text, terminal: t, stashed: null };
    }
    if (t === "response.output_item.added" || t === "response.output_item.done") {
      const item = ev.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") sawTools = true;
    }
    if (t === "response.output_text.delta" && typeof ev.delta === "string") text += ev.delta;
    yield ev;
  }
  return { sawTools, text, terminal, stashed };
}

export async function* runGoalTurns(
  first: AsyncGenerator<GoalEvent>,
  ctx: GoalCtx,
): AsyncGenerator<GoalEvent> {
  const cap = Number.isInteger(ctx.maxRounds) && ctx.maxRounds >= 0 ? Math.min(ctx.maxRounds, 1000) : 1000;
  let current: AsyncGenerator<GoalEvent> = first;
  let rounds = 0;
  for (;;) {
    const turn = yield* drainTurn(current);
    if (turn.terminal !== "completed" || !turn.stashed) {
      // incomplete/failed/error 已在 drainTurn 内透传; "done" 无终端则静默收尾 (门面守卫兜底)。
      if (turn.stashed) yield turn.stashed;
      return;
    }
    const toolsProvided = ctx.tools.length > 0;
    if (!toolsProvided || turn.sawTools || rounds >= cap) {
      yield turn.stashed;
      return;
    }
    const verdict = await judgeTurn(ctx, turn.text);
    if (verdict.verdict === "complete") {
      yield turn.stashed;
      return;
    }
    rounds++;
    console.info(`[goal] turn ${rounds}/${cap}: no-tools completed, judge CONTINUE, continuing`);
    // 续轮: chat 消息数组追加 assistant 文本轮 + user nudge, 其余 (tools/reasoning/参数) 保持首轮。
    const baseMessages = ctx.baseBody.messages as Array<Record<string, unknown>>;
    const body: Record<string, unknown> = {
      ...ctx.baseBody,
      messages: [
        ...baseMessages,
        { role: "assistant", content: turn.text || "(previous turn produced no text)" },
        {
          role: "user",
          content:
            `System note: your previous response ended without calling any tools, but the task is not complete. ` +
            `Judge feedback: ${verdict.reason} Continue the task now by calling the appropriate tools. ` +
            `Do not repeat summaries; proceed with tool calls.`,
        },
      ],
    };
    let up: Response;
    try {
      up = await ctx.postChatUpstream(body);
    } catch (e) {
      yield errorEvent(502, `goal continuation unreachable: ${(e as Error)?.message ?? e}`);
      return;
    }
    if (!up.ok || up.body === null) {
      let detail = `status ${up.status}`;
      try {
        detail = JSON.stringify(await up.json()).slice(0, 300);
      } catch {
        /* keep status */
      }
      yield errorEvent(up.status, `goal continuation rejected: ${detail}`);
      return;
    }
    current = ctx.streamEvents(up.body);
  }
}
