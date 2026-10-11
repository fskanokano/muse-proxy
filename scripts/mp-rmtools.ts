// responses/messages tool_loop 长链取证: agent 风格多轮工具回合 (3 轮),
// 每轮解析 function_call -> 本地执行 -> 回传 -> 下一轮。
// 用法: MP_TEST_KEY=.. bun run scripts/mp-rmtools.ts [responses|messages] [direct|gw]
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

const TOOL_DEF = { name: "read_file", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const ASK = "First call read_file on 'src/index.ts', then read_file on 'src/config.ts', then summarize both files in your final answer. Do each step with full reasoning.";

type Call = { id: string; name: string; args: string };

function respBody(model: string, input: unknown[]): Record<string, unknown> {
  return {
    model, input, stream: true,
    tools: [{ type: "function", name: TOOL_DEF.name, description: TOOL_DEF.description, parameters: TOOL_DEF.parameters }],
    tool_choice: "auto",
    reasoning: { effort: "high", summary: "auto" },
  };
}
function msgBody(model: string, messages: unknown[]): Record<string, unknown> {
  return {
    model, messages, stream: true, max_tokens: 8000,
    tools: [{ name: TOOL_DEF.name, description: TOOL_DEF.description, input_schema: TOOL_DEF.parameters }],
  };
}

async function oneRound(endpoint: string, model: string, payload: Record<string, unknown>): Promise<{ status: number; calls: Call[]; textLen: number; terminal: string; frames: number; err: string }> {
  const out = { status: 0, calls: [] as Call[], textLen: 0, terminal: "", frames: 0, err: "" };
  try {
    const res = await fetch(URL + "/v1/" + endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer " + KEY, "content-type": "application/json",
        ...(endpoint === "messages" ? { "anthropic-version": "2023-06-01" } : {}),
      },
      body: JSON.stringify(payload),
    });
    out.status = res.status;
    if (!res.ok || !res.body) {
      out.err = (await res.text().catch(() => "")).slice(0, 300);
      return out;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const pend = new Map<string, Call>();
    const deadline = Date.now() + 590_000;
    while (true) {
      if (Date.now() > deadline) {
        out.err = "TEST-TIMEOUT-590s";
        break;
      }
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        if (p.startsWith(":")) continue;
        const lines = p.split("\n");
        let ev = "";
        let data = "";
        for (const ln of lines) {
          if (ln.startsWith("event:")) ev = ln.slice(6).trim();
          else if (ln.startsWith("data:")) data += ln.slice(5).trim();
        }
        if (!data) continue;
        out.frames++;
        if (data === "[DONE]") {
          out.terminal = "[DONE]";
          break;
        }
        try {
          const j = JSON.parse(data) as Record<string, unknown>;
          const t = typeof j.type === "string" ? j.type : "";
          if (t === "response.completed" || t === "message_stop") {
            out.terminal = t;
            break;
          }
          if (t === "response.failed" || t === "error") {
            out.terminal = t;
            out.err = data.slice(0, 300);
            break;
          }
          // responses function_call 聚合
          if (t === "response.output_item.added" || t === "response.output_item.done") {
            const item = j.item as Record<string, unknown> | undefined;
            if (item && item.type === "function_call" && typeof item.name === "string") {
              const id = typeof item.id === "string" ? item.id : (typeof item.call_id === "string" ? item.call_id : "");
              const prev = pend.get(id) ?? { id, name: item.name, args: "" };
              prev.name = item.name as string;
              if (typeof item.arguments === "string") prev.args = item.arguments as string;
              pend.set(id, prev);
            }
          }
          if (t === "response.function_call_arguments.done") {
            const iid = typeof j.item_id === "string" ? j.item_id : "";
            const c = pend.get(iid);
            if (c && typeof j.arguments === "string") c.args = j.arguments as string;
          }
          // messages tool_use 聚合
          if (t === "content_block_start") {
            const b = j.content_block as Record<string, unknown> | undefined;
            if (b && b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
              pend.set(b.id as string, { id: b.id as string, name: b.name as string, args: "" });
            }
          }
          if (t === "content_block_delta") {
            const d = j.delta as Record<string, unknown> | undefined;
            if (d && d.type === "input_json_delta" && typeof d.partial_json === "string") {
              const idx = typeof j.index === "number" ? j.index : 0;
              const arr = [...pend.values()];
              const c = arr[idx];
              if (c) c.args += d.partial_json as string;
            }
            if (d && d.type === "text_delta" && typeof d.text === "string") out.textLen += (d.text as string).length;
          }
          if (t === "response.output_text.delta" && typeof j.delta === "string") out.textLen += (j.delta as string).length;
        } catch {
          /* 非 JSON */
        }
      }
      if (out.terminal) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
    out.calls = [...pend.values()].filter((c) => c.id && c.name);
  } catch (e) {
    out.err = "fetch-throw: " + ((e as Error)?.message ?? e);
  }
  return out;
}

async function runModel(model: string): Promise<void> {
  const t0 = Date.now();
  let rounds = 0;
  let ok = true;
  let note = "";
  // responses/messages 的多轮输入形态
  let rInput: unknown[] = [{ role: "user", content: [{ type: "input_text", text: ASK }] }];
  let mMsgs: unknown[] = [{ role: "user", content: ASK }];
  while (rounds < 4) {
    rounds++;
    const payload = ENDPOINT === "responses" ? respBody(model, rInput) : msgBody(model, mMsgs);
    const r = await oneRound(ENDPOINT, model, payload);
    console.log("  [" + model + "] round" + rounds + " status=" + r.status + " frames=" + r.frames + " terminal=" + r.terminal + " tools=" + r.calls.map((c) => c.name).join(",") + " text=" + r.textLen + (r.err ? " ERR=" + r.err : ""));
    if (r.status !== 200 || (r.terminal !== "response.completed" && r.terminal !== "message_stop")) {
      ok = false;
      note = "round" + rounds + " terminal=" + r.terminal + " " + r.err;
      break;
    }
    if (r.calls.length === 0) break;
    const outs = r.calls.map((c) => JSON.stringify({ ok: true, path: "src/index.ts", size: 1234 }));
    if (ENDPOINT === "responses") {
      const items: unknown[] = [];
      for (let i = 0; i < r.calls.length; i++) {
        const c = r.calls[i]!;
        items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.args || "{}" });
        items.push({ type: "function_call_output", call_id: c.id, output: outs[i] });
      }
      rInput = [...rInput, ...items];
    } else {
      const assists: unknown[] = r.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: JSON.parse(c.args || "{}") }));
      const users: unknown[] = r.calls.map((c, i) => ({ type: "tool_result", tool_use_id: c.id, content: outs[i] }));
      mMsgs = [...mMsgs, { role: "assistant", content: assists }, { role: "user", content: users }];
    }
  }
  console.log((ok ? "OK  " : "FAIL") + " " + model + " rounds=" + rounds + " total=" + ((Date.now() - t0) / 1000).toFixed(1) + "s" + (note ? " " + note : ""));
}

console.log("endpoint=" + ENDPOINT + " mode=" + MODE);
for (const m of MODELS) {
  await runModel(m);
}
console.log("rmtools done");
