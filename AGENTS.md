# AGENTS.md(supabase 分支)

opencode 会话的工作地图。长文真相源是 `README.md`(排查手册 §1–§10 记录了每一次
"整代理全挂"事故与接入新模型的多分支清单);改管线逻辑前先到 README 核实。

## 本仓库最重要的结构事实:三分支架构

同一个代理,三个部署宿主;分支之间**内容并不相同**,靠人工同步:

- **supabase(当前分支)**:本分支部署为单个 Supabase Edge Function(Deno
  运行时),实现本体在 `supabase/functions/muse-proxy/**`;`api/*.ts` 只是薄
  Vercel 外壳(re-export + handler 尾巴),一个实现两个宿主——**绝不要在外壳
  里 fork 管线**。
- **egress**:同一棵实现树 + `server/`(本地常驻运行时、出口 IP 轮换)、
  `admin-web/`、Docker、`scripts/mp-*`。那些文件不在本分支。
- **main**:Vercel 形态。实现本体在 `api/_lib/*.ts`(与 supabase 树同构但独立
  维护),门面 `api/{chat,responses,messages,models}.ts` 带 Vercel handler 壳尾。

同步规则(README §7.4):**每个模型/管线变更必须三条分支都落地**。egress 独有
文件(server/、admin-web/、docker、mp-*)绝不外流。切换分支后发现"模型消失",
先查 `git diff origin/<分支>..<分支> -- '*types.ts'`,别急着怀疑上游。

## 本分支的 Edge 工作流

- `bun run typecheck:edge` = `deno check`(`index.ts`/`router.ts`/`serve-edge.ts`
  /`fake-supabase.ts` 被 `tsc --noEmit` 排除,只能用它覆盖)。Deno 未装,用
  `npx --yes deno@latest check|bundle …`。
- `serve:edge`:无 Docker 直接跑 Edge Function(`$PORT`,默认 8788)。
- `smoke:edge`:Edge Function 真上游 HTTP 套件,需先起 `serve:edge`(详细用法
  看脚本头注释)。
- `serve:fake`:先 `bundle:function` 再跑 `fake-supabase.ts` 本地假宿主;产物
  `supabase/.temp` 别带进提交。
- `deploy:functions`:`supabase functions deploy muse-proxy`(需要 supabase CLI
  与权限)。
- 本地开发更省事的组合:`bun run serve:edge` + `bun run smoke:edge`
  (smoke 系列直打真上游时不需要本地宿主)。

## 导入 specifier 陷阱(弄错直接 break tsc)

- `supabase/functions/muse-proxy/**` 的 import 必须写显式 `.ts` specifier
  (Deno 解析器要求;tsconfig 已为此开 `allowImportingTsExtensions`)。
- 本分支 tsconfig 的 include 包含 `api/**`、`test/**`、`scripts/**` 与
  supabase 函数树;Deno 入口被 exclude,见上。
- test 与 scripts 引实现体的两种路径:`../api/<name>`(门面)与
  `../supabase/functions/muse-proxy/_lib/<x>.ts`(管线本体)。

## 命令

- 任何改动过门禁:`bun run typecheck && bun run typecheck:edge && bun run test`。
  仓库无 lint/format/CI。
- `bun run test` 全 mock 上游(vitest;`e2e.local` 与 `integration.mock` 自己起
  本地 HTTP 服务)——**无需联网**。本分支 208 个测试(egress 217 / main 192,
  数量不齐是分支使然)。单文件:`bunx vitest run test/<name>.test.ts`。
- 真上游冒烟(需 `.env` 与网络):`bun run smoke`、`smoke:responses`、
  `smoke:messages`、`smoke:newmodels`、`smoke:efforts`、`smoke:tools`、
  `smoke:openminis`、`eval`。矩阵大可分片:
  `bun run smoke:newmodels [模型…] [--steps=chat,chat-stream,…]`。
- 本分支没有 `mp:serve` / `mp-smoke`(那是 egress 独有的本机运行时)。

## 上游纪律(为什么"看起来无害的改动"会全挂)

当前出站全部走
`POST https://opencode.ai/inference/openai/v1/chat/completions`(oa-compat
chat)。已退役:Responses 直发(`/inference/v1/responses`,全部模型)、muse
直发(模型弃用)、网络挂载 `/inference/v1/chat`。

三道硬门禁,每道都是过去的真实事故(README §2–§8),位置在本分支
`supabase/functions/muse-proxy/_lib/` 下:

1. **免费层要求 `stream:true`**——`stream:false` → 403 FreeTierError。goal
   模型的 judge 因此流式聚合;`oa-compat.ts` 的
   `OaCompatRaiser.finishStream(done | eof)` 同时守截断帧。
2. **客户端指纹**(UA `opencode/<channel>/<version>/<client>`、session-id
   编码、完整头集合)在 `types.ts` / `identity.ts` 伪造;对照真实客户端形状,
   **别"顺手清理"常量**。
3. **模型路由**:`types.ts` 的 `resolveModel`——`muse*`、goal 与任意未知 id
   经 `upstreamId` 别名到 `deepseek-v4.1-flash-free`(上游看到 deepseek,
   客户端看到自己的 id 回显);`step-5-preview-free` 上游已死,目录故意保留。

接入新模型 = 多文件多分支清单(README §7.2):`MODELS` 目录 + `resolveModel`
别名 + 不依赖 .env 的测试 + 冒烟脚本 + README。**动实现前先用
`scripts/probe-*.ts` 当模板打真上游**。

## 运维细节

- `.env(.local)` 被 gitignore;.env.example 记录全部变量。
- glm 偶发 429 `upstream_rate_limited`("Endpoint is unavailable")——重跑
  冒烟再诊断,别改断言。
- 零运行时依赖是设计意图(本分支连 tsx 都没有);不往管线里引重库。
- 提交信息:`<type>: <中文或英文摘要>`,type ∈ feat/fix/sync。
