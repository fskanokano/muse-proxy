// 同体对照: 同一个 agent 风格任务体, 同时打 /v1 (老部署) 与 /mp/v1 (本地),
// 跑两轮 tool 回合, 逐轮对比 tool_calls/finish/DONE。
// 用法: GW_KEY=.. bun run scripts/mp-compare.ts
export {};
const GW = "http://127.0.0.1:8080";
const KEY = process.env.GW_KEY ?? "";
if (!KEY) throw new Error("GW_KEY required");

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information",
      parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "number" } }, required: ["query"] },
    },
  },
];

function buildBody(round: number): Record<string, unknown> {
  const base: Record<string, unknown>[] = [
    { role: "system", content: "You are a research agent. Always use web_search to verify facts before answering. Reason thoroughly." },
    { role: "user", content: "帮我搜索一下oracle已经绑定的预留ip会不会收费，给出完整结论" },
  ];
  if (round === 2) {
    base.push(
      { role: "assistant", content: null, tool_calls: [{ id: "call_cmp1", type: "function", function: { name: "web_search", arguments: "{\"query\":\"oracle reserved IP charge\"}" } }] },
      { role: "tool", tool_call_id: "call_cmp1", content: JSON.stringify({ results: [{ title: "Oracle IP pricing", snippet: "Reserved public IPs attached to instances are free; unattached reserved IPs incur hourly charge." }] }) },
    );
  }
  return { model: "muse-spark-1.3-contributor-free", messages: base, tools: TOOLS, stream: true } as Record<string, unknown>;
}

async function runRound(path: string, round: number): Promise<{ status: number; frames: number; done: boolean; tools: string[]; finish: string; err: string; textLen: number }> {
  const out = { status: 0, frames: 0, done: false, tools: [] as string[], finish: "", err: "", textLen: 0 };
  try {
    const res = await fetch(GW + path, {
      method: "POST",
      headers: { authorization: "Bearer " + KEY, "content-type": "application/json" },
      body: JSON.stringify(buildBody(round)),
    });
    out.status = res.status;
    if (!res.ok || !res.body) {
      out.err = (await res.text().catch(() => "")).slice(0, 300);
      return out;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const acc = new Map<number, { id: string; name: string }>();
    const deadline = Date.now() + 590_000;
    while (true) {
      if (Date.now() > deadline) {
        out.err = "TEST-TIMEOUT";
        break;
      }
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        if (!p.startsWith("data:")) continue;
        out.frames++;
        const payload = p.slice(5).trim();
        if (payload === "[DONE]") {
          out.done = true;
          break;
        }
        try {
          const j = JSON.parse(payload) as {
            choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string }; index?: number }> } }>;
          };
          const ch = j.choices && j.choices[0];
          if (ch && ch.finish_reason) out.finish = ch.finish_reason;
          const tc = ch && ch.delta ? ch.delta.tool_calls : undefined;
          if (tc) for (const c of tc) acc.set(c.index ?? 0, { id: c.id ?? "", name: (c.function && c.function.name) || "" });
          const co = ch && ch.delta ? ch.delta.content : undefined;
          if (typeof co === "string") out.textLen += co.length;
        } catch {
          /* ignore */
        }
      }
      if (out.done) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
    out.tools = [...acc.values()].map((t) => t.name).filter(Boolean);
  } catch (e) {
    out.err = "throw: " + ((e as Error)?.message ?? e);
  }
  return out;
}

for (const path of ["/v1/chat/completions", "/mp/v1/chat/completions"]) {
  console.log("=== " + path + " ===");
  for (const round of [1, 2]) {
    const r = await runRound(path, round);
    console.log(
      "round" + round + " status=" + r.status + " frames=" + r.frames + " finish=" + r.finish + " tools=[" + r.tools.join(",") + "] text=" + r.textLen + " done=" + r.done + (r.err ? " ERR=" + r.err : ""),
    );
    if (!r.done) break;
  }
}
console.log("compare done");
