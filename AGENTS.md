# AGENTS.md(main 分支)

opencode 会话的工作地图。长文真相源是 `README.md`(排查手册 §1–§10 记录了每一次
"整代理全挂"事故与接入新模型的多分支清单);改管线逻辑前先到 README 核实。

## 本仓库最重要的结构事实:三分支架构

同一个代理,三个部署宿主;分支之间**内容并不相同**,靠人工同步:

- **main(当前分支)**:Vercel 部署形态,是**唯一一棵实现本体不在
  `supabase/functions/` 的分支**。实现本体在 `api/_lib/*.ts`;门面
  `api/{chat,responses,messages,models}.ts` 是"实现内容体 + Vercel 壳尾"的
  组合体——保留各自的 `export default { fetch }` 与 `POST`/`GET` 导出。
  `vercel.json` 把 `/v1/*` 重写到 `/api/*`,后三者 `maxDuration: 300`。
  本分支没有 `supabase/` 树、没有 `server/`、没有 Deno 脚本。
- **supabase**:Supabase Edge Function(Deno)部署,实现本体在
  `supabase/functions/muse-proxy/**`。
- **egress**:同一棵 supabase 实现树 + `server/`(本地常驻运行时、出口 IP
  轮换)、`admin-web/`、Docker、`scripts/mp-*`。

同步规则(README §7.4):**每个模型/管线变更必须三条分支都落地**。把
egress/supabase 树的改动搬过来时要按本分支惯例重写:门面路径
`../supabase/functions/muse-proxy/<f>.ts` → `../api/<f>`,管线
`_lib/<x>.ts` → `api/_lib/<x>`( specifier 规则见下一节)。egress 独有文件
(server/、admin-web/、docker、mp-*、`test/egress*.test.ts`)绝不引入。
切换分支后发现"模型消失",先查
`git diff origin/<分支>..<分支> -- '*types.ts'`,别急着怀疑上游。

## 导入 specifier 陷阱(弄错直接 break tsc;本分支最容易猜错)

- `api/_lib/*` 之间互相 import 用 **`.js` specifier**(`import … from
  "./types.js"`),由 tsc 解析到同名 `.ts` 文件。
- 文件本身必须是 `.ts`。**绝不创建真实 `.js` 文件**——tsc 报 TS7016
  (`allowJs` 是关的);也不要把已有 `.ts` 改名 `.js`。
- test/scripts 引实现的路径:`../api/<name>`(门面)、`../api/_lib/<x>.js`
  (管线本体)。
- 本分支 `typecheck` 只覆盖 `api/**`、`test/**`、`scripts/**`;没有
  `typecheck:edge`——`bun run typecheck` 就是全量。

## 命令

- 任何改动过门禁:`bun run typecheck && bun run test`。仓库无 lint/format/CI。
- `bun run test` 全 mock 上游(vitest;`test/e2e.local.test.ts` 与
  `integration.mock` 自己起本地 HTTP 服务)——**无需联网**。本分支 195 个
  (egress 220 / supabase 211,数量不齐是分支使然)。单文件:
  `bunx vitest run test/<name>.test.ts`。
- 真上游冒烟(需 `.env` 与网络):`bun run smoke`、`smoke:responses`、
  `smoke:messages`、`smoke:newmodels`、`smoke:efforts`、`smoke:tools`、
  `smoke:openminis`、`eval`。矩阵大可分片:
  `bun run smoke:newmodels [模型…] [--steps=chat,chat-stream,…]`。
- 本分支没有 `mp:serve` / `mp-smoke` / `serve:edge`(能跑本地服务的是
  egress 分支;`serve:edge`/`deploy:functions` 在 supabase / egress 分支)。

## 上游纪律(为什么"看起来无害的改动"会全挂)

当前出站全部走
`POST https://opencode.ai/inference/openai/v1/chat/completions`(oa-compat
chat)。已退役:Responses 直发(`/inference/v1/responses`,全部模型)、muse
直发(模型弃用)、网络挂载 `/inference/v1/chat`。

三道硬门禁,每道都是过去的真实事故(README §2–§8),位置在本分支 `api/_lib/`
下(chat.ts / messages.ts / responses.ts 三门面共用):

1. **免费层要求 `stream:true`**——`stream:false` → 403 FreeTierError。goal
   模型的 judge 因此流式聚合;`oa-compat.ts` 的
   `OaCompatRaiser.finishStream(done | eof)` 同时守截断帧。
2. **客户端指纹**(UA `opencode/<channel>/<version>/<client>`、session-id
   编码、完整头集合)在 `types.ts` / `identity.ts` 伪造;对照真实客户端形状,
   **别"顺手清理"常量**。
3. **模型路由**:`types.ts` 的 `resolveModel`——`muse*`、`step-5*`、goal 与任意
   未知 id 经 `upstreamId` 别名到 `deepseek-v4.1-flash-free`(上游看到
   deepseek,客户端看到自己的 id 回显);两个退役 id 以 `listed: false` 从
   `/v1/models` 下架、保留解析;存活集(mimo / space-bunny / deepseek / glm /
   big-pickle / longcat / beam / nemotron ×3)各自直连。

接入新模型 = 多文件多分支清单(README §7.2):`MODELS` 目录 + `resolveModel`
别名 + 不依赖 .env 的测试 + 冒烟脚本 + README。**动实现前先用
`scripts/probe-*.ts` 当模板打真上游**;免费集全量复核用
`bun run scripts/probe-free-sweep.ts`(读 models.opencode.ai catalog + 双挂载
真探)。403 `FreeTierError` 文案为 "abusive traffic from this network" 时是
**IP 级封锁**(与指纹无关)——换出口或等待,别改指纹常量。

## 运维细节

- `.env` 被 gitignore;本分支冒烟脚本需要它提供上游环境。
- glm 偶发 429 `upstream_rate_limited`("Endpoint is unavailable")——重跑
  冒烟再诊断,别改断言。
- 零运行时依赖是设计意图(本分支 dependencies 为空);不往管线里引重库。
- 提交信息:`<type>: <中文或英文摘要>`,type ∈ feat/fix/sync。
