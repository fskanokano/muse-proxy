// chat completions 长对话取证: agent 风格多轮 (system + 工具 + 多轮 tool 回合),
// 每模型跑长思考任务, 记录首字节/总时长/帧数/DONE/中断点/上游真实状态。
// 用法: MP_BASE=.. MP_TEST_KEY=.. bun run scripts/mp-chatlong.ts [direct|gw]
export {};
const MODE = process.argv[2] ?? "direct";
const BASE = process.env.MP_BASE ?? "http://127.0.0.1:18091";
const GW = "http://127.0.0.1:8080/mp";
const KEY = process.env.MP_TEST_KEY ?? "";
const URL = MODE === "gw" ? GW : BASE;

const SYS = "You are an expert coding agent. Think thoroughly before acting. Use tools when needed.";
function buildTools() {
  return [
    { type: "function", function: { name: "read_file", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    { type: "function", function: { name: "write_file", description: "write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } },
  ];
}
const TASK =
  "You are doing a deep architecture review. First, call read_file on 'src/index.ts' to inspect the entry, " +
  "then call read_file on 'src/config.ts', then write your full 3000-word analysis to 'REVIEW.md' via write_file. " +
  "Think exhaustively at each step (at least 1000 words of reasoning per step), never skip tool calls, " +
  "never give a final answer without completing all three tool steps. Begin now.";

const MODELS = [
  "muse-spark-1.3-contributor-free",
  "mimo-v2.6-flash-free",
  "space-bunny-free",
  "step-5-preview-free",
];

type ChatDelta = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string }; index?: number }>;
    };
  }>;
};

async function runOne(model: string): Promise<void> {
  const t0 = Date.now();
  let first = -1;
  let frames = 0;
  let done = false;
  let status = 0;
  let finishReason = "";
  let errText = "";
  let maxGap = 0;
  let lastT = t0;
  // agent 式多轮: 首轮拿 tool_calls -> 本地执行 -> 回传 tool 结果 -> 次轮,
  // 最多 4 轮, 每轮独立计时, 任何一轮断流都算 FAIL。
  let messages: Array<Record<string, unknown>> = [
    { role: "system", content: SYS },
    { role: "user", content: TASK },
  ];
  let rounds = 0;
  try {
    while (rounds < 4) {
      rounds++;
      const r0 = Date.now();
      let rFirst = -1;
      let rFrames = 0;
      let rDone = false;
      let rStatus = 0;
      let rFinish = "";
      let rErr = "";
      let toolCalls: Array<{ id: string; name: string; args: string }> = [];
      let textSoFar = "";
      const res = await fetch(`${URL}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, tools: buildTools(), stream: true }),
      });
      rStatus = res.status;
      status = rStatus;
      if (!res.ok || !res.body) {
        rErr = (await res.text().catch(() => "")).slice(0, 400);
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        const deadline = Date.now() + 590_000;
        while (true) {
          if (Date.now() > deadline) {
            rErr = "TEST-TIMEOUT-590s (stream still open, client gave up)";
            break;
          }
          const { done: d, value } = await reader.read();
          if (d) break;
          const now = Date.now();
          if (first < 0) first = now - t0;
          if (rFirst < 0) rFirst = now - r0;
          maxGap = Math.max(maxGap, now - lastT);
          lastT = now;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const p of parts) {
            if (!p.startsWith("data:")) continue;
            frames++;
            rFrames++;
            const payload = p.slice(5).trim();
            if (payload === "[DONE]") rDone = true;
            else {
              try {
                const j = JSON.parse(payload) as ChatDelta;
                const ch = j.choices ? j.choices[0] : undefined;
                if (ch && ch.finish_reason) {
                  rFinish = ch.finish_reason;
                  finishReason = rFinish;
                }
                const tc = ch && ch.delta ? ch.delta.tool_calls : undefined;
                if (tc) {
                  for (const c of tc) {
                    const idx = c.index ?? 0;
                    const prev = toolCalls[idx];
                    const slot = prev ? prev : { id: "", name: "", args: "" };
                    if (c.id) slot.id = c.id;
                    if (c.function && c.function.name) slot.name = c.function.name;
                    if (c.function && c.function.arguments) slot.args += c.function.arguments;
                    toolCalls[idx] = slot;
                  }
                }
                const content = ch && ch.delta ? ch.delta.content : undefined;
                if (typeof content === "string") textSoFar += content;
              } catch {
                /* 非 JSON 帧 */
              }
            }
          }
          if (rDone) {
            try {
              await reader.cancel();
            } catch {
              /* ignore */
            }
            break;
          }
        }
      }
      done = rDone;
      if (!rDone || rStatus !== 200) {
        errText = `round${rounds}: status=${rStatus} frames=${rFrames} finish=${rFinish} err=${rErr}`;
        break;
      }
      console.log(`  [${model}] round${rounds} first=${rFirst}ms frames=${rFrames} finish=${rFinish} tools=${toolCalls.map((t) => t.name).join(",") || "-"} text=${textSoFar.length}ch`);
      // 有完整 tool_calls 则执行并继续下一轮, 否则本模型结束。
      const ready = toolCalls.filter((t) => t.id && t.name);
      if (ready.length === 0) break;
      messages = [
        ...messages,
        { role: "assistant", content: null, tool_calls: ready.map((t, i) => ({ id: t.id, type: "function", index: i, function: { name: t.name, arguments: t.args || "{}" } })) },
        ...ready.map((t) => ({ role: "tool", tool_call_id: t.id, content: JSON.stringify({ ok: true, path: "src/index.ts", size: 1234 }) })),
      ];
    }
  } catch (e) {
    errText = `fetch-throw: ${(e as Error)?.message ?? e}`;
  }
  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `${done && !errText ? "OK  " : "FAIL"} ${model} status=${status} first=${first}ms total=${total}s rounds=${rounds} frames=${frames} finish=${finishReason} maxgap=${maxGap}ms done=${done}` +
      (errText ? ` ERR=${errText}` : ""),
  );
}

console.log(`mode=${MODE} url=${URL}`);
for (const m of MODELS) {
  await runOne(m);
}
console.log("chatlong done");
