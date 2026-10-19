# AGENTS.md(egress 分支)

opencode 会话的工作地图。长文真相源是 `README.md`(排查手册 §1–§10 记录了每一次
"整代理全挂"事故与接入新模型的多分支清单);改管线逻辑前先到 README 核实。

## 本仓库最重要的结构事实:三分支架构

同一个代理,三个部署宿主;分支之间**内容并不相同**,靠人工同步:

- **egress(当前分支)**:本机常驻部署(Docker host 网络)。实现本体在
  `supabase/functions/muse-proxy/**`;`api/*.ts` 是薄 Vercel 外壳(re-export +
  handler 尾巴)。本分支独有:`server/`(本地运行时,含出口 IP 轮换
  `server/egress.ts`)、`admin-web/`、`Dockerfile` + `docker-compose.yml`、
  `scripts/mp-*.ts`、`test/egress*.test.ts`。
- **supabase**:同一棵 `supabase/functions/muse-proxy/**` 部署为 Supabase Edge
  Function;没有 `server/`,也没有 `scripts/mp-*`。
- **main**:Vercel 形态。实现本体在 `api/_lib/*.ts`;门面
  `api/{chat,responses,messages,models}.ts` 带 Vercel handler 壳尾
  (`export default { fetch }` + `POST`/`GET`)。`vercel.json` 把
  `/v1/*` 重写到 `/api/*`,后三者 `maxDuration: 300`。

同步规则(README §7.4):**每个模型/管线变更必须三条分支都落地**。egress 独有
文件绝不外流到另外两线。切换分支后发现"模型消失",先查
`git diff origin/<分支>..<分支> -- '*types.ts'`,别急着怀疑上游。

## 导入 specifier 陷阱(弄错直接 break tsc)

- `supabase/functions/muse-proxy/**` 的 import 必须写显式 `.ts` specifier
  (Deno 解析器要求;tsconfig 已为此开 `allowImportingTsExtensions`)。
- 在 main 分支上,`api/_lib/*` 之间互相 import 用 `.js` specifier、解析到同名
  `.ts` 文件;**绝不创建真实 `.js` 文件**(tsc 报 TS7016,`allowJs` 是关的)。
- Deno 入口 `supabase/functions/muse-proxy/index.ts`、`scripts/serve-edge.ts`、
  `scripts/fake-supabase.ts` 被 `tsc --noEmit` 排除;用 `bun run typecheck:edge`
  (deno check)覆盖。Deno 未装,用 `npx --yes deno@latest check|bundle …`。

## 命令

- 任何改动过门禁:`bun run typecheck && bun run test`,本分支还要
  `bun run typecheck:edge`(tsc 覆盖面含 `server/**`)。仓库无 lint/format/CI。
- `bun run test` 全 mock 上游(vitest;`test/e2e.local.test.ts` 与
  `integration.mock` 自己起本地 HTTP 服务)——**无需联网**。本分支 220 个。
  单文件:`bunx vitest run test/<name>.test.ts`。
- 真上游冒烟(需 `.env` 与网络):`bun run smoke`、`smoke:responses`、
  `smoke:messages`、`smoke:newmodels`、`smoke:efforts`、`smoke:tools`、
  `smoke:openminis`、`eval`。矩阵大可分片:
  `bun run smoke:newmodels [模型…] [--steps=chat,chat-stream,…]`。
- 本地起服:`bun run mp:serve` = `tsx server/main.ts`,读 `.env`
  (PROXY_API_KEY、MP_ADMIN_PASSWORD、MP_PORT):
  ```bash
  setsid env $(grep -v '^#' .env | xargs) MP_PORT=18099 \
    nohup bun run mp:serve > /tmp/opencode/mp-serve.log 2>&1 &
  ```
- 对它冒烟:`set -a; . ./.env; set +a;
  MP_BASE=http://127.0.0.1:18099 bun run scripts/mp-smoke.ts`(13 项:三门面 +
  admin + egress 副出口 + muse SSE)。**别对常驻 18091 docker 容器冒烟**——
  可能是陈旧/密钥不匹配进程;空闲端口开新实例。

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
   编码、完整头集合)在 `types.ts` / `identity.ts` 伪造;对照真实客户端形状
   (本机 /tmp/opencode/src 有 v2.0.32 源码快照时核对),**别"顺手清理"常量**。
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

- `.env` 被 gitignore 且机器相关;`.env.example` 记录全部变量,含
  `MP_GOAL_MAX_ROUNDS`(goal 自动续轮上限,0–1000)。
- glm 偶发 429 `upstream_rate_limited`("Endpoint is unavailable")——重跑
  冒烟再诊断,别改断言。
- 零运行时依赖是设计意图(本分支仅 `tsx`);不往管线里引重库。
- 提交信息:`<type>: <中文或英文摘要>`,type ∈ feat/fix/sync。
- 日志放 /tmp/opencode;`bundle:function` 的产物 `supabase/.temp` 别带进提交。
