// 四模型长对话取证: 每模型一个真推理任务 (长思考+工具调用优先),
// 记录首字节/总时长/帧数/DONE/中断点, 直连 mp 跑 (排除网关层)。
// 用法: MP_BASE=.. MP_TEST_KEY=.. bun run scripts/mp-longtest.ts
export {};
const BASE = process.env.MP_BASE ?? "http://127.0.0.1:18091";
const KEY = process.env.MP_TEST_KEY ?? "";

const TASK =
  "Design a lock-free multi-producer multi-consumer ring buffer in Rust. " +
  "Think step by step: memory ordering for head/tail (Acquire/Release vs SeqCst), " +
  "ABA handling with epoch counters, cache-line padding to avoid false sharing, " +
  "and backpressure policy when full. Then write the full code with tests. " +
  "Be thorough, at least 200 lines of code with detailed reasoning.";

const MODELS = [
  "muse-spark-1.3-contributor-free",
  "mimo-v2.6-flash-free",
  "space-bunny-free",
  "step-5-preview-free",
];

async function runOne(model: string): Promise<void> {
  const t0 = Date.now();
  let firstByte = -1;
  let frames = 0;
  let done = false;
  let lastEvent = "";
  let status = 0;
  let errText = "";
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: TASK }], stream: true }),
    });
    status = res.status;
    if (!res.ok || !res.body) {
      errText = (await res.text().catch(() => "")).slice(0, 300);
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done: d, value } = await reader.read();
        if (d) break;
        if (firstByte < 0) firstByte = Date.now() - t0;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          if (!p.startsWith("data:")) continue; // 心跳注释不计
          frames++;
          const payload = p.slice(5).trim();
          lastEvent = payload.slice(0, 120);
          if (payload === "[DONE]") done = true;
        }
        if (done) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
      }
    }
  } catch (e) {
    errText = `fetch-throw: ${(e as Error)?.message ?? e}`;
  }
  const total = Date.now() - t0;
  console.log(
    `${done ? "OK  " : "FAIL"} ${model} status=${status} first=${firstByte}ms total=${(total / 1000).toFixed(1)}s frames=${frames} done=${done}` +
      (errText ? ` err=${errText}` : ` last=${lastEvent}`),
  );
}

for (const m of MODELS) {
  await runOne(m);
}
console.log("longtest done");
