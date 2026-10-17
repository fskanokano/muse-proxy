# AGENTS.md

Compressed map for opencode sessions. Long-form source of truth: `README.md`
(troubleshooting手册 §1–§10 documents every "whole proxy died" incident and the
new-model checklist). Verify claims there before changing pipeline logic.

## Three-branch architecture (the #1 thing to get right)

Same proxy, three hosts; branches are NOT identical and are synced manually:

- **egress** (default working branch): local persistent deployment (Docker
  host-network). Implementation lives in `supabase/functions/muse-proxy/**`;
  `api/*.ts` are thin Vercel shells re-exporting it. Branch adds `server/`
  (local runtime incl. egress-exit-IP rotation via `server/egress.ts`),
  `admin-web/`, `Dockerfile` + `docker-compose.yml`, `scripts/mp-smoke.ts`,
  `test/egress*.test.ts`.
- **supabase**: same `supabase/functions/muse-proxy/**` tree deployed as a
  Supabase Edge Function; no `server/` tree. Also carries `api/` shells.
- **main**: Vercel form. Real code lives in `api/_lib/*.ts`; facades
  `api/{chat,responses,messages,models}.ts` have Vercel handler tails
  (`export default { fetch }` + `POST`/`GET`). `vercel.json` rewrites
  `/v1/*` → `/api/*`.

Sync rule (README §7.4): every model/pipeline change lands on **all three
branches**. egress-only files never propagate. If a "model disappears" after
switching branches, first check
`git diff origin/<branch>..<branch> -- '*types.ts'`.

## Import-specifier quirks (break tsc if done wrong)

- `supabase/functions/muse-proxy/**` imports use explicit `.ts` specifiers
  (Deno resolver). tsconfig sets `allowImportingTsExtensions` for it.
- On **main**, `api/_lib/*` import each other via `.js` specifiers that
  resolve to the `.ts` files. Never create real `.js` files there (tsc fails
  with TS7016, `allowJs` is off).
- Deno entrypoints `supabase/functions/muse-proxy/index.ts`,
  `scripts/serve-edge.ts`, `scripts/fake-supabase.ts` are EXCLUDED from
  `tsc --noEmit`; typecheck them with `bun run typecheck:edge` (deno check).
  Deno is not installed locally: use `npx --yes deno@latest check|bundle …`.

## Commands

- Gate for any change: `bun run typecheck && bun run test` and, on
  supabase/egress trees, `bun run typecheck:edge`. No lint/format/CI config.
- `bun run test` is fully mock-upstream (vitest; `test/e2e.local.test.ts` and
  `integration.mock` spin their own local HTTP servers) — no network needed.
  Test counts differ per branch by design: egress 217 / supabase 208 /
  main 192. Single file: `bunx vitest run test/<name>.test.ts`.
- Real-upstream smokes (need `.env` + network): `bun run smoke`,
  `smoke:responses`, `smoke:messages`, `smoke:newmodels`,
  `smoke:efforts`, `smoke:tools`, `smoke:openminis`, `eval`.
  `smoke:newmodels [model …] [--steps=chat,chat-stream,…]` shards its matrix.
- Local server (egress): load `.env` (PROXY_API_KEY, MP_ADMIN_PASSWORD,
  MP_PORT) and `bun run mp:serve` = `tsx server/main.ts`:
  ```bash
  setsid env $(grep -v '^#' .env | xargs) MP_PORT=18099 \
    nohup bun run mp:serve > /tmp/opencode/mp-serve.log 2>&1 &
  ```
- Smoke against it: `set -a; . ./.env; set +a;
  MP_BASE=http://127.0.0.1:18099 bun run scripts/mp-smoke.ts` (13 checks).
  Do NOT smoke against the standing 18091 docker container — it may hold a
  stale/key-mismatched process; start a fresh instance on a free port.
- Supabase-only helpers (`serve:edge`, `serve:fake`, `deploy:functions`) exist
  in package.json but are irrelevant on main/egress work.

## Upstream discipline (why "innocent changes" kill everything)

All current outbound traffic goes to
`POST https://opencode.ai/inference/openai/v1/chat/completions` (oa-compat
chat). Retired: Responses direct (`/inference/v1/responses` — all models),
muse direct (model deprecated), network mount `/inference/v1/chat`.

Three hard gates, each a past outage (README §2–§8):

1. **Free tier requires `stream:true`** — `stream:false` → 403 FreeTierError.
   This is why the goal model's judge streams and aggregates. `openssl`-level
   detail lives in `_lib/oa-compat.ts` (`OaCompatRaiser.finishStream(done |
   eof)` also guards truncated-frame handling).
2. **Client fingerprint** (UA `opencode/<channel>/<version>/<client>`,
   session-id encoding, full header set) is forged in `_lib/identity.ts` /
   `_lib/types.ts`. Match the real client's shape (source snapshots live in
   `/tmp/opencode/src` when present); do not "clean up" these constants.
3. **Model routing**: `resolveModel` in `_lib/types.ts` — `muse*`, goal and
   ANY unknown id alias to `deepseek-v4.1-flash-free` via `upstreamId`
   (upstream sees deepseek, client sees its own id echoed back).
   `step-5-preview-free` is upstream-dead but intentionally kept cataloged.

Adding a model = multi-file, multi-branch checklist (README §7.2): `MODELS`
catalog + `resolveModel` aliasing + `.env`-independent tests + smoke scripts +
README. Probe the real upstream FIRST with one of `scripts/probe-*.ts` as
template before implementing.

## Operational gotchas

- `.env` is gitignored and machine-specific; `.env.example` documents every
  var incl. `MP_GOAL_MAX_ROUNDS` (goal auto-continuation cap, 0–1000).
- glm requests can fail transiently with 429 `upstream_rate_limited`
  ("Endpoint is unavailable") — retry the smoke before diagnosing.
- Zero runtime deps by design (only `tsx` on egress); heavy deps are
  neither wanted nor anywhere in the pipeline.
- Commit messages: `<type>: <中文或英文摘要>`, type ∈ feat/fix/sync.
- Output logs land in /tmp/opencode on this host; keep build artifacts
  (`supabase/.temp` from `bundle:function`) out of commits.
