// mp 本地冒烟: 健康 + 模型表 + 后台 + 真上游 SSE (只读, 不改模式)。
// 用法: MP_BASE=http://127.0.0.1:18091 MP_TEST_KEY=<PROXY_API_KEY> MP_ADMIN_PASSWORD=<pwd> bun run scripts/mp-smoke.ts
const BASE = process.env.MP_BASE ?? "http://127.0.0.1:18091";
const KEY = process.env.MP_TEST_KEY ?? "";
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
check(
  "models",
  models.status === 200 && Array.isArray(modelsJson?.data) && modelsJson.data.some((m) => m.id === "muse-spark-1.3-contributor-free"),
  `status=${models.status}`,
);

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
