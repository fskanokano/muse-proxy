// responses/messages 长对话取证: agent 风格长任务, 记录中断证据。
// 用法: MP_TEST_KEY=.. bun run scripts/mp-rmlong.ts [responses|messages] [direct|gw]
export {};
const ENDPOINT = process.argv[2] ?? "responses";
const MODE = process.argv[3] ?? "direct";
const BASE = process.env.MP_BASE ?? "http://127.0.0.1:18091";
const GW = "http://127.0.0.1:8080/mp";
const KEY = process.env.MP_TEST_KEY ?? "";
const URL = MODE === "gw" ? GW : BASE;

const MODELS = [
  "muse-spark-1.3-contributor-free",
  "mimo-v2.6-flash-free",
  "space-bunny-free",
  "step-5-preview-free",
];

const LONG_TEXT =
  "Do an exhaustive architecture review of a TypeScript monorepo ESM migration: " +
  "every failure mode, codemod scripts, per-package steps, rollback plan. " +
  "Reason at least 2000 words before the final guide. Be exhaustive, do not summarize.";

function buildBody(model: string): Record<string, unknown> {
  if (ENDPOINT === "responses") {
    return {
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: LONG_TEXT }] }],
      stream: true,
      reasoning: { effort: "high", summary: "auto" },
    };
  }
  return {
    model,
    max_tokens: 8000,
    stream: true,
    thinking: { type: "enabled", budget_tokens: 4000 },
    messages: [{ role: "user", content: LONG_TEXT }],
  };
}

async function runOne(model: string): Promise<void> {
  const t0 = Date.now();
  let first = -1;
  let frames = 0;
  let done = false;
  let terminal = "";
  let status = 0;
  let errText = "";
  let maxGap = 0;
  let lastT = t0;
  try {
    const res = await fetch(`${URL}/v1/${ENDPOINT}`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(buildBody(model)),
    });
    status = res.status;
    if (!res.ok || !res.body) {
      errText = (await res.text().catch(() => "")).slice(0, 400);
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 590_000;
      while (true) {
        if (Date.now() > deadline) {
          errText = "TEST-TIMEOUT-590s (stream still open)";
          break;
        }
        const r = await reader.read();
        if (r.done) break;
        const now = Date.now();
        if (first < 0) first = now - t0;
        maxGap = Math.max(maxGap, now - lastT);
        lastT = now;
        buf += decoder.decode(r.value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          if (!p.startsWith("data:") && !p.startsWith("event:")) continue;
          const lines = p.split("\n");
          let evType = "";
          let data = "";
          for (const ln of lines) {
            if (ln.startsWith("event:")) evType = ln.slice(6).trim();
            else if (ln.startsWith("data:")) data += ln.slice(5).trim();
          }
          if (!data) continue;
          frames++;
          if (data === "[DONE]") {
            done = true;
            terminal = "[DONE]";
          } else {
            try {
              const j = JSON.parse(data) as { type?: string };
              if (j.type === "response.completed" || j.type === "response.incomplete" || j.type === "message_stop" || j.type === "response.failed" || j.type === "error") {
                terminal = j.type;
                if (j.type === "response.completed" || j.type === "message_stop") done = true;
              }
            } catch {
              /* 非 JSON */
            }
          }
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
    errText = "fetch-throw: " + ((e as Error)?.message ?? e);
  }
  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    (done ? "OK  " : "FAIL") + " " + model + " status=" + status + " first=" + first + "ms total=" + total + "s frames=" + frames + " terminal=" + terminal + " maxgap=" + maxGap + "ms" + (errText ? " ERR=" + errText : ""),
  );
}

console.log("endpoint=" + ENDPOINT + " mode=" + MODE + " url=" + URL);
for (const m of MODELS) {
  await runOne(m);
}
console.log("rmlong done");
