// mp 本地冒烟: 健康 + 模型表 + 后台 + 真上游 SSE (只读, 不改模式)。
// 用法: MP_BASE=http://127.0.0.1:18091 MP_ADMIN_PASSWORD=<pwd> bun run scripts/mp-smoke.ts
// (MP_TEST_KEY 缺省回退到 .env.local 里的 PROXY_API_KEY, 与其余 smoke 脚本一致)
export {};
const BASE = process.env.MP_BASE ?? "http://127.0.0.1:18091";
const KEY = process.env.MP_TEST_KEY ?? process.env.PROXY_API_KEY ?? "";
const ADMIN = process.env.MP_ADMIN_PASSWORD ?? "";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

const health = await fetch(`${BASE}/mp-healthz`);
check("healthz", health.ok && (await health.text()) === "ok");

const models = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
const modelsJson = (await models.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
// 退役 id(muse / step-5)不上架;目录必须含存活模型(sanity: deepseek 在, muse 不在)。
check(
  "models",
  models.status === 200 && Array.isArray(modelsJson?.data) &&
    modelsJson.data.some((m) => m.id === "deepseek-v4.1-flash-free") &&
    !modelsJson.data.some((m) => m.id === "muse-spark-1.3-contributor-free"),
  `status=${models.status}`,
);
const deepseekEntry = modelsJson?.data?.find((m) => m.id === "deepseek-v4.1-flash-free") as
  | { reasoning?: boolean; reasoning_levels?: string[] }
  | undefined;
check(
  "models advertises deepseek-v4.1-flash-free (reasoning low/high/max)",
  deepseekEntry?.reasoning === true && deepseekEntry?.reasoning_levels?.join(",") === "low,high,max",
  JSON.stringify(deepseekEntry?.reasoning_levels),
);
const glmEntry = modelsJson?.data?.find((m) => m.id === "glm-5.3-flash-free") as
  | { reasoning?: boolean; reasoning_levels?: string[] }
  | undefined;
check(
  "models advertises glm-5.3-flash-free (reasoning low/high/max)",
  glmEntry?.reasoning === true && glmEntry?.reasoning_levels?.join(",") === "low,high,max",
  JSON.stringify(glmEntry?.reasoning_levels),
);

// deepseek / glm 走 oa-compat 上游, 三个门面各打一次真实上游 (非流式, 断言文本回显)。
for (const MODEL of ["deepseek-v4.1-flash-free", "glm-5.3-flash-free"]) {
  for (const [label, path, body, headers] of [
    ["chat", "/v1/chat/completions", { model: MODEL, stream: false, messages: [{ role: "user", content: "Reply with exactly: LOCAL-OK" }] }, { authorization: `Bearer ${KEY}` }],
    ["responses", "/v1/responses", { model: MODEL, input: "Reply with exactly: LOCAL-OK", stream: false }, { authorization: `Bearer ${KEY}` }],
    ["messages", "/v1/messages", { model: MODEL, max_tokens: 256, messages: [{ role: "user", content: "Reply with exactly: LOCAL-OK" }] }, { "x-api-key": KEY }],
  ] as const) {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    check(`${MODEL} ${label} real upstream`, res.status === 200 && text.includes("LOCAL-OK"), `status=${res.status} ${text.replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

const login = await fetch(`${BASE}/admin/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: ADMIN }),
});
const loginJson = (await login.json().catch(() => null)) as { token?: string } | null;
check("admin login", login.status === 200 && typeof loginJson?.token === "string", `status=${login.status}`);
const token = loginJson?.token ?? "";

const egress = await fetch(`${BASE}/admin/api/egress`, { headers: { "x-admin-key": token } });
const egressJson = (await egress.json().catch(() => null)) as {
  mode?: string;
  secondaries?: Array<{ ip?: string; name?: string }>;
} | null;
check(
  "egress discovery",
  egress.status === 200 && Array.isArray(egressJson?.secondaries) && egressJson.secondaries.length > 0,
  `mode=${egressJson?.mode} secondaries=${egressJson?.secondaries?.length ?? 0}`,
);

const t0 = Date.now();
const sse = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: "muse-spark-1.3-contributor-free",
    messages: [{ role: "user", content: "reply with exactly: OK" }],
    stream: true,
    max_tokens: 32,
  }),
});
const firstByteMs = Date.now() - t0;
const ctype = sse.headers.get("content-type") ?? "";
let frames = 0;
let done = false;
if (sse.body) {
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done: d, value } = await reader.read();
    if (d) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const p of parts) {
      if (p.startsWith("data:")) {
        frames++;
        if (p.includes("[DONE]")) done = true;
      }
    }
    if (done) break;
  }
}
check("sse stream", sse.status === 200 && ctype.includes("text/event-stream") && frames > 1 && done, `first_byte=${firstByteMs}ms frames=${frames} done=${done}`);

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all mp smoke checks passed");
