// 代理层 goal 自动续轮 (实验: 仅 muse-spark-1.3-contributor-goal 模型触发)。
//
// 触发条件 (必须同时满足, 缺一即原样放行):
//  1. 上游以 response.completed 干净收尾 (incomplete/failed/error 照常透传, 不干预);
//  2. 本轮零工具调用, 但请求里带了 tools (无 tools 的请求如标题生成天然豁免);
//  3. 未超续轮上限 (MP_GOAL_MAX_ROUNDS, 默认 1000, 0 = 与 muse 行为完全一致);
//  4. judge 判 CONTINUE (裁判即当前模型自身; 判 COMPLETE/判读失败/调用失败一律收尾)。
//
// 续轮做法: 原历史 + 本轮文本 assistant 项 + user nudge 项, 重新 POST 上游
// (stream:true), 事件拼回同一条下游流 (中间终端事件全部吞掉, 只放行最终
// 终端, 各门面自带的截断守卫因此不受影响)。usage 只反映最后一轮, 见 README。
//
// 终止性审计 (每条路都通向 return):
//  failed/error/incomplete 终端 -> 直接透传收尾; "done" 无终端 -> 收尾 (门面守卫兜底);
//  有工具/无tools可供/超cap/judge COMPLETE(含一切失败) -> 放行收尾;
//  每次 CONTINUE 消耗一轮 cap, cap 耗尽即收尾。单客户端请求的上游调用数
//  上界 = 1 + cap*(judge + continuation), 默认 cap=1000 (实际受网关超时与成本约束先到)。

import { parseUpstreamSse } from "./sse.ts";
import {
  MODEL_MUSE,
  type ModelInfo,
  type UpstreamInputItem,
  type UpstreamTool,
} from "./types.ts";

export type GoalEvent = Record<string, unknown> | "done";

export interface GoalIdentity {
  sessionId: string;
  requestId: string;
}

export interface GoalCtx {
  model: ModelInfo;
  /** 门面已 lower 好的上游 body 原型 (stream:true, 含 tools/reasoning, 续轮时只换 input)。 */
  baseBody: Record<string, unknown>;
  /** 当前轮的上游 input (续轮在此基础上追加)。 */
  input: UpstreamInputItem[];
  tools: UpstreamTool[];
  /** 最多续轮数 (MP_GOAL_MAX_ROUNDS, 0-1000, 缺省 1000, 0 = 与 muse 行为完全一致)。 */
  maxRounds: number;
  identity: GoalIdentity;
  /** 发往上游 responses 端点的原始 POST (门面闭包, 自带指纹头/signal)。 */
  postUpstream: (body: Record<string, unknown>) => Promise<Response>;
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

function extractOutputText(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) return "";
  const texts: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "output_text") {
        const t = (part as { text?: unknown }).text;
        if (typeof t === "string") texts.push(t);
      }
    }
  }
  return texts.join("\n");
}

type Verdict = { verdict: "complete" | "continue"; reason: string };

async function judgeTurn(ctx: GoalCtx, turnText: string): Promise<Verdict> {
  const done = (verdict: Verdict["verdict"], reason: string): Verdict => {
    console.info(`[goal] judge -> ${verdict}${reason ? ` (${reason.slice(0, 120)})` : ""}`);
    return { verdict, reason };
  };
  const task = firstUserText(ctx.input);
  const body = {
    model: ctx.model.upstreamId ?? MODEL_MUSE,
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
    stream: false,
    store: false,
    reasoning: { effort: "minimal" },
    tools: ctx.tools,
    tool_choice: "auto",
    max_output_tokens: 256,
    prompt_cache_key: ctx.identity.sessionId,
  };
  let res: Response;
  try {
    res = await ctx.postUpstream(body);
  } catch (e) {
    return done("complete", `judge request failed: ${(e as Error)?.message ?? e}`);
  }
  if (!res.ok) {
    try {
      await res.text().catch(() => "");
    } catch {
      /* ignore */
    }
    return done("complete", `judge upstream status ${res.status}`);
  }
  let text = "";
  try {
    text = extractOutputText(await res.json());
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
  let input = ctx.input;
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
    input = [
      ...input,
      { role: "assistant", content: [{ type: "output_text", text: turn.text || "(previous turn produced no text)" }] },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `System note: your previous response ended without calling any tools, but the task is not complete. ` +
              `Judge feedback: ${verdict.reason} Continue the task now by calling the appropriate tools. ` +
              `Do not repeat summaries; proceed with tool calls.`,
          },
        ],
      },
    ];
    let up: Response;
    try {
      up = await ctx.postUpstream({ ...ctx.baseBody, input });
    } catch (e) {
      yield errorEvent(502, `goal continuation unreachable: ${(e as Error)?.message ?? e}`);
      return;
    }
    if (!up.ok || !up.body) {
      let detail = `status ${up.status}`;
      try {
        detail = JSON.stringify(await up.json()).slice(0, 300);
      } catch {
        /* keep status */
      }
      yield errorEvent(up.status, `goal continuation rejected: ${detail}`);
      return;
    }
    current = parseUpstreamSse(up.body) as AsyncGenerator<GoalEvent>;
  }
}
