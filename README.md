# muse-proxy

一个把 opencode zen 的免费模型包装成标准 OpenAI Chat Completions / Responses 与 Anthropic Messages API 的无状态代理,零运行时依赖,可部署到 Vercel 等 edge/Node 环境。

- **入站**:`POST /api/chat`(OpenAI `/v1/chat/completions` 兼容,支持流式 SSE 与聚合 JSON、工具调用、`reasoning_effort`)
- **入站**:`POST /api/responses`(OpenAI `/v1/responses` Responses API 规范,支持流式 SSE 与聚合 JSON、工具调用、加密思考回放,详见下文)
- **入站**:`POST /api/messages`(Anthropic `/v1/messages` Messages API 规范,支持流式 SSE 与聚合 JSON、工具调用、thinking 块,详见下文)
- **出站**:按模型分格式路由(zen 边缘按格式路由,2026-09-24 探针确认):
  - `muse-spark-1.3-contributor-free` → `POST https://opencode.ai/zen/v1/responses`(OpenAI Responses API + SSE)
  - `mimo-v2.6-flash-free` → `POST https://opencode.ai/zen/v1/chat/completions`(oa-compat;走 `/v1/responses` 上游直接 500)
  - `space-bunny-free` → `POST https://opencode.ai/zen/v1/chat/completions`(oa-compat;走 `/v1/responses` 上游 401 `ModelError: not supported for format openai`)
- **鉴权**:`Authorization: Bearer $PROXY_API_KEY` 或 `x-api-key: $PROXY_API_KEY`(三个端点共用同一鉴权逻辑)。**未设置 `PROXY_API_KEY` 环境变量时,所有端点一律返回 401(fail-closed),不存在开放模式**
- **免费模型**:上游 API key 固定为字面量 `public`,匿名免费层按 IP 限额,无需注册
- **模型路由**(`api/_lib/types.ts` 的 `resolveModel`):显式匹配 `mimo*`/`space-bunny*`/`muse*` 前缀,其余任意 model id 沿用历史行为回落 muse;三个端点对同一 model id 语义一致
- **思考强度**:逐档位实测上游接受度(2026-09-24,`scripts/probe-reasoning-efforts.ts`),`/v1/models` 每个模型暴露 `reasoning` + `reasoning_levels`:
  - `muse-spark-1.3-contributor-free`:`none/minimal/low/medium/high/xhigh`(`max` 上游 400);Anthropic 门面的 `thinking.budget_tokens` 档位映射不变
  - `mimo-v2.6-flash-free`:reasoning **恒开**,`reasoning_effort` 上游容忍但无效,故不暴露档位、不下发该字段
  - `space-bunny-free`:`minimal/low/medium/high/xhigh/max`(目录外还多接受 `minimal`);请求 `none` 会被钳制为 `minimal`(直接转发上游 400);Anthropic 门面 `thinking:{type:"disabled"}` 同样钳制为 `minimal`
  - 钳制逻辑集中在 `clampEffortForModel`(`api/_lib/types.ts`),三个门面共用

```
client ──chat/completions──▶ muse-proxy ─┬─lower──▶ opencode zen /v1/responses      (muse)
        ◀──SSE chunks────               └─chat-upstream──▶ /v1/chat/completions    (mimo / space-bunny)
                                                          └─raise─▶ 同一套 raise 层
```

新增的两个 oa-compat 模型(`api/_lib/chat-upstream.ts` + `api/_lib/oa-compat.ts`):降级(Responses input → chat messages,含 function_call 轮次回放：连续并行调用合并成一条 `assistant(content=null, tool_calls=[...])`，拆散上游直接 400)与升格(chat-completions SSE → 规范 Responses 事件生命周期:`response.created` → `output_item.added` → 文本/思考 delta → `output_text.done`/`output_item.done` → `response.completed`),三个门面共享同一转换层,语义(muse 门的工具暴露、心跳、终止事件守护)与 muse 路径完全一致。对 OpenMinis 2026-09-02 源码 (`4ef2900`) 的 Responses 解析器还补齐了 function-call 的 `output_item.added` → `function_call_arguments.delta` → `function_call_arguments.done` → `output_item.done` 顺序,避免工具参数被严格客户端静默丢弃。`/v1/models` 目录已包含全部三个模型。

## 模型目录

代理当前服务 **3 个 opencode zen 免费模型**。`GET /v1/models`(`api/models.ts`)按 OpenAI models-list 格式返回下表全部模型,每个条目携带 `reasoning`(是否思考)与 `reasoning_levels`(支持的思考强度档位,空数组 = 无档位控制)元数据,另有 `context_window` / `max_output_tokens` / `owned_by: "opencode-zen"`。所有模型共享免费匿名层:上游 API key 固定为字面量 `public`,按 IP 限额,无需注册;三个 API 门面(chat / responses / messages)对同一 model id 语义一致。

| 模型 ID | 名称 | 上游格式(出站路由) | 上下文窗口 | 最大输出 | 思考 | 思考强度档位 |
|---|---|---|---|---|---|---|
| `muse-spark-1.3-contributor-free` | Muse Spark 1.3 Contributor Free (opencode zen) | `responses` → `POST https://opencode.ai/zen/v1/responses` | 1,048,576 | 32,000 | ✅ | `none / minimal / low / medium / high / xhigh`(默认 `high`;`max` 上游 400) |
| `mimo-v2.6-flash-free` | MiMo-V2.6-Flash Free | `oa-compat` → `POST https://opencode.ai/zen/v1/chat/completions` | 200,000 | 32,000 | ✅ 恒开 | 无(上游容忍 `reasoning_effort` 但无效,代理不下发该字段) |
| `space-bunny-free` | Space Bunny Free | `oa-compat` → `POST https://opencode.ai/zen/v1/chat/completions` | 1,048,576 | 32,000 | ✅ 恒开 | `minimal / low / medium / high / xhigh / max`(`none` 钳制为 `minimal`,直接转发上游 400) |

### muse-spark-1.3-contributor-free(默认模型)

- **定位**:Muse Spark 1.3 Contributor 免费层,经 opencode zen 原生 Responses 上游提供;**任何未知/未匹配的 model id 都回落到这里**(历史行为,永不报 404)。
- **别名**:`model id 含 "muse"` 即匹配(如 `muse`、`muse-spark-1.3`)。
- **思考**:支持**加密思考回放**——流式/聚合响应携带 `encrypted_content`(Responses 门面)或 `reasoning_details`(chat 门面),多轮对话原样透传回上游;Anthropic 门面的 `thinking.budget_tokens` 档位映射不变(`<2048→low`、`<8192→medium`、`<24576→high`、`≥24576→xhigh`,`disabled→none`)。
- **路由格式**:唯一走 `responses` 上游的模型(`lower.ts` 直发 `/zen/v1/responses`)。
- **定义处**:`api/_lib/types.ts` 的 `MUSE_INFO`。

### mimo-v2.6-flash-free

- **定位**:MiMo Flash,面向多模态编码 agent 与长上下文自动化(免费层)。
- **别名**:`model id 以 "mimo" 开头(大小写不敏感)即匹配——包括 zen 付费目录名 `mimo-v2.6-flash`(由免费上游变体服务)。
- **思考**:reasoning **恒开且无法关闭**;`reasoning_effort` / `reasoning.effort` / `thinking.budget_tokens` 会被接受并静默丢弃(上游 200 但无效),`/v1/models` 不暴露档位,代理也不向下游发该字段。
- **路由格式**:`oa-compat`(chat completions);走 `/v1/responses` 上游会直接 500,opencode CLI 同样经 `@ai-sdk/openai-compatible` 调用它。
- **定义处**:`api/_lib/types.ts` 的 `MIMO_INFO`。

### space-bunny-free

- **定位**:匿名限时预览的推理模型,面向编码、agent 任务、工具调用与多模态输入(免费层,限时提供)。
- **别名**:`model id 包含 "space-bunny"` 即匹配(如 `space-bunny`、`space-bunny-free-preview`)。
- **思考**:reasoning 恒开;接受全部档位 `minimal/low/medium/high/xhigh/max`(比官方目录还多接受 `minimal`);请求 `none` 会被 `clampEffortForModel` 钳制为 `minimal`——直接转发上游会 400;Anthropic 门面 `thinking:{type:"disabled"}` 同样钳制为 `minimal`。
- **并行工具调用**:同轮多个 `tool_calls` 必须合并在一条 `assistant` 消息里回放,拆成多条 `assistant` 消息(每条带一个调用)上游直接 400 `invalid_request_error`。网关客户端习惯并行调用,多轮后必触发,表现为“聊几句就报错”。代理已在 `api/_lib/chat-upstream.ts` 的 `lowerInputToMessages` 内把连续 `function_call` 聚合成一条 `assistant(content=null, tool_calls=[...])`,三个门面共用,无需客户端改形状。
- **路由格式**:`oa-compat`(chat completions);走 `/v1/responses` 上游返回 401 `ModelError: not supported for format openai`。

> 上表的档位接受度均为 2026-09-24 逐档位实测结论(`scripts/probe-reasoning-efforts.ts`);路由与钳制逻辑集中在 `api/_lib/types.ts`(`resolveModel` / `clampEffortForModel`),三个门面共用,新增模型时先更新 `MODELS` 目录再跑 `bun run smoke:newmodels` 与 `bun run smoke:efforts`。

## 快速开始

```bash
bun install            # 或 npm install
bun run test           # 156 个单元/集成/沙箱端到端测试(mock 上游,无需联网)
bun run smoke          # 真实连通性冒烟(需联网,验证 stream:false 与 stream:true)
bun run smoke:responses # /v1/responses 真实上游全功能冒烟(需联网,7 项 36 检查)
bun run smoke:messages  # /v1/messages 真实上游全功能冒烟(需联网,8 项任务)
bun run smoke:newmodels # 两个新模型 × 三门面全链路真实上游冒烟(需联网,9 项任务 × 2 模型 + muse 回归)
bun run smoke:efforts  # 思考强度档位真实上游冒烟:/v1/models 元数据 + 档位端到端 + none 钳制
bun run smoke:tools    # agent 工具循环真实上游冒烟:3 模型 × 3 门面,流式 tool call → 执行 → 回传 → 结果落地
bun run smoke:openminis # OpenMinis file_write 真实上游探针:3 门面 × 5 个参数的全量回放 + 模型生成工具调用
bun run eval           # 完整 agent 评测:xhigh 思考 + web_search 工具循环 + 3 轮多轮对话
bun run typecheck
```

---

## OpenAI Responses 端点:`POST /v1/responses`

除 chat completions 门面外,代理还直接暴露 OpenAI **Responses API** 规范端点(`api/responses.ts`,Vercel rewrite `/v1/responses → /api/responses`)。上游本来就是 Responses API,因此该端点是**归一化 + 指纹修补**模式,与 chat 端点完全独立、互不影响(不共享可变逻辑;`lower.ts`/`chat.ts` 未被改动)。

```bash
curl -X POST https://your-proxy/v1/responses \
  -H "Authorization: Bearer $PROXY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"anything","input":"hi","stream":false}'
```

支持范围:

- `input`:字符串,或数组项 `{role, content}` / `{type:"message"}`(user 支持 `input_text`/`input_image` parts,assistant 支持 `output_text`)、`{type:"function_call"}`、`{type:"function_call_output"}`、`{type:"reasoning"}`(加密思考回放项原样透传)
- `instructions`:转为首条 system 消息;`reasoning.effort`:白名单同 chat 端点(默认 `high`)
- `tools`:Responses 扁平 function 工具(误传 chat 嵌套形状也兼容),追加在内置工具之后
- `stream:true`:按 Responses 流式规范以 `event: <type>` + `data: <json>` 帧逐事件透传上游事件(不发 `[DONE]`,与 OpenAI Responses 流式一致),带心跳注释;oa-compat 模型会合成完整 function-call 生命周期(`output_item.added`、`function_call_arguments.delta/done`、`output_item.done`),兼容 OpenMinis 等严格 Responses 客户端;上游混入的非规范 `ping` 保活帧被过滤(`response.completed` 始终是终止事件);若上游未发终止事件就断流,合成 `error`(`upstream_stream_truncated`)事件再关闭,截断不会被误当成正常完成
- `stream:false`:聚合为单个 `response` 对象(`object:"response"`、`output`、`output_text`、`usage`、`status: completed/incomplete`);上游断流未发终止事件时返回 502 `upstream_stream_truncated`,绝不把截断输出标成 `completed`

有意的限制(免费层契约):

- **无状态**:`previous_response_id` 非空直接 400,请把完整对话放进 `input`
- `store` 恒为 `false`,`include` 恒为 `["reasoning.encrypted_content"]`;无 `encrypted_content` 的 reasoning 项被丢弃(上游会 400)
- `tool_choice` 恒为 `auto`(上游仅支持);OpenAI 服务端工具类型(`web_search` 等)被忽略——上游内置的 `websearch` 等工具已随指纹携带
- 任意 `model` id 都映射到免费模型;请求头/请求体指纹规则与 chat 端点完全一致

---

## Anthropic Messages 端点:`POST /v1/messages`

第三个门面:Anthropic **Messages API** 规范端点(`api/messages.ts`,Vercel rewrite `/v1/messages → /api/messages`)。与 chat/responses 门面完全独立(`messages-lower.ts`/`messages-raise.ts` 是独立文件,`lower.ts`/`chat.ts`/`responses-lower.ts`/`responses.ts` 未被改动),但共享同一套 opencode 免费层指纹规则与 `PROXY_API_KEY` 鉴权。

```bash
curl -X POST https://your-proxy/v1/messages \
  -H "x-api-key: $PROXY_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-anything","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

鉴权遵循 Anthropic SDK 惯例:`x-api-key` 头(共享的 `checkAuth` 也接受 `Authorization: Bearer`),同样使用 `PROXY_API_KEY` 环境变量。错误一律用 Anthropic 错误信封 `{"type":"error","error":{"type":...,"message":...}}`。

支持范围:

- `messages`:`content` 为字符串或内容块;user 支持 `text`/`image`(base64 与 url source)/`tool_result` 块,assistant 支持 `text`/`tool_use` 块;`thinking` 块在输入侧被丢弃(上游回放走的是 OpenAI `encrypted_content`,Anthropic 门面不携带,丢掉不影响多轮记忆)
- `system`:字符串或 text 块数组,转为首条 system 消息
- `max_tokens`:**必填**(与真实 API 一致,缺失直接 400),钳制到上游上限;`temperature`/`top_p` 透传;`stop_sequences`/`metadata`/`top_k` 接受但忽略
- `thinking:{type:"enabled",budget_tokens}`:`<2048 → low`,`<8192 → medium`,`<24576 → high`,`≥24576 → xhigh`;`{type:"disabled"} → none`
- `tools`:`{name,description?,input_schema}` 形状,追加在桩化内置工具之后(与其它门面相同的免费层指纹规则,同名遮蔽被丢弃)
- `stream:true`:规范 Anthropic SSE 事件序列 `message_start → content_block_start/delta/stop(text/thinking/tool_use)→ message_delta(stop_reason+usage)→ message_stop`,`event:` + `data:` 帧无 `[DONE]`,带心跳注释;上游非规范 `ping` 帧被过滤;上游断流未发终止事件时合成 `error` 事件,截断不会被误当成完整消息
- `stream:false`:聚合为单个 `message` 对象(`content` 含 `text`/`thinking`/`tool_use` 块,`stop_reason: end_turn/max_tokens/tool_use`,`usage`);上游断流未发终止事件时返回 502
- `stop_reason` 映射:`response.incomplete → max_tokens`,出现工具调用 → `tool_use`,其余 → `end_turn`
- 上游错误映射:429 → `rate_limit_error`,400 → `invalid_request_error`,其余 → 502 `api_error`(与其它门面一致)

---

# 排查手册:上游更新导致 "OpenCode's free tier can only be used from within OpenCode"

> 免费层不是按账号鉴权的,而是**按客户端指纹鉴权**。opencode zen 一旦收紧指纹校验,代理立刻失效——这不是 bug,是设计如此。本文记录三轮完整的排查-定位-修复过程(第一轮:头指纹;第二轮:请求体工具集指纹;第三轮:**session ID 编码指纹**),上游下次再变时照此办理。

## 1. 报错长什么样

第一轮是所有请求返回 429:

```json
{
  "error": {
    "message": "OpenCode's free tier can only be used from within OpenCode",
    "type": "rate_limit_error"
  }
}
```

第二轮(门槛升级后)变成 403 + `FreeTierError`:

```json
{
  "type": "error",
  "error": {
    "type": "FreeTierError",
    "message": "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"
  }
}
```

昨天还能用、今天突然全挂、本地没有任何改动——这是典型的**上游行为变更**特征,优先怀疑上游而不是自己的代码。报错状态码/结构的变化本身就是门槛升级的信号。

## 2. 第一轮排查:头指纹(按顺序做)

### 第一步:确认是上游门槛,不是限流

- 报错信息不是 "rate limit exceeded" 之类,而是资格类拒绝;换 IP 也没用 → 不是 IP 限额问题。
- 用**真实 opencode CLI** 发同一模型请求,成功 → 说明门槛在"请求长得像不像 opencode",而不是模型本身不可用。

### 第二步:精读 opencode 源码,找出它到底发了什么

关键在于 opencode 是开源的,合法且高效的路径就是读它的请求构造代码:

1. 拉最近一个月的提交,重点看与 zen、provider、request 相关的变更:
   ```bash
   git clone https://github.com/anomalyco/opencode
   git log --since="1 month ago" --oneline
   ```
2. 请求构造在 `packages/opencode/src/session/llm/request.ts`:每次请求带一组 `x-opencode-*` 头(session/request/client/project)+ 特定 User-Agent。
3. ID 生成在 `packages/opencode/src/id/id.ts` 的 `Identifier.create`:`<prefix>_` + 12 位十六进制时间分量(`(ms<<12|counter)` 的低 48 位)+ 14 位 base62 随机,总长 26 字符,前缀如 `ses_`/`msg_`/`prt_`。
4. User-Agent 在 `packages/opencode/src/installation/index.ts`:格式 `opencode/${channel}/${version}/${client}`,例如 `opencode/latest/1.18.31/cli`。
5. 版本号从 npm `opencode-ai` 包的 latest dist-tag 取,保证和真实客户端一致。

### 第三步:对照自己发出的请求,逐个头找差异

| 头 | opencode 真实客户端 | 旧版代理(被拒) |
|---|---|---|
| `user-agent` | `opencode/latest/1.18.31/cli` | `opencode/1.2.31`(版本陈旧、缺 channel/client 段) |
| `x-opencode-client` | `cli` | ❌ 缺失 |
| `x-opencode-session` | `ses_<26位opencode id>` | ❌ 裸 `crypto.randomUUID()` |
| `x-opencode-request` | `msg_<26位opencode id>` | ❌ 缺失 |
| `x-opencode-project` | 稳定的项目键 | ❌ 缺失 |

差异一目了然:上游把校验从"UA 网关"升级成了"**完整头指纹**",任何一项不像都会被分进严格拒绝桶。

### 第四步:确定门槛位置(知其所以然)

在 opencode 源码里 grep 这个报错文案是搜不到的——说明校验**不在开源 CLI 里,而在闭源的 zen 边缘服务**。开源仓库只能告诉你"真实客户端发什么",不能告诉你"服务端怎么验"。因此修复策略是完整模仿客户端指纹,而不是寻找服务端开关。

## 3. 第一轮修复(已实施):完整头指纹

核心思路:**让代理发出的每个请求都和真实 opencode CLI 无法区分**。

### 3.1 `api/_lib/types.ts` — UA 与版本常量化

```ts
export const OPENCODE_VERSION = "1.18.31"   // 跟随 npm opencode-ai 的 latest
export const OPENCODE_CHANNEL = "latest"
export const OPENCODE_CLIENT = "cli"
export const UPSTREAM_USER_AGENT = `opencode/${OPENCODE_CHANNEL}/${OPENCODE_VERSION}/${OPENCODE_CLIENT}`
```

### 3.2 `api/_lib/identity.ts` — 复刻 opencode 的 ID 形状(新增)

按 `Identifier.create` 的布局生成 26 字符 ID(`ses_`/`msg_`/`prt_` 前缀 + 12 位时间分量 + 14 位 base62),并对 `(callId, role)` 确定性生成——同一补发请求保持同一身份,模拟真实客户端的重试行为。

### 3.3 `api/chat.ts` — 发送完整头指纹

```ts
const identity = identityForCall(completionId)
headers: {
  authorization: "Bearer public",
  "user-agent": UPSTREAM_USER_AGENT,
  "x-opencode-session": identity.sessionId,
  "x-opencode-request": identity.requestId,
  "x-opencode-client": OPENCODE_CLIENT,
  "x-opencode-project": identity.requestId,   // msg id 兼作项目键,一个会话一个项目
}
```

### 3.4 验证

```bash
bun run test   # mock 层新增指纹断言;76/76 通过
bun run smoke  # 真实上游连通;stream:false / stream:true 双路径通过
bun run eval   # agent 评测 21/21:流式、xhigh 思考、工具循环、多轮记忆
```

## 4. 第二轮事件(2026-09-18):工具集指纹

修复上线数天后再次全挂,报错升级为 **403** + `FreeTierError` + "Error from provider (Console): ..."(旧的是 429 `rate_limit_error`)。这次门槛从**头指纹**扩展到了**请求体指纹**——`tools` 数组也在被校验。

### 4.1 定位过程(二分法探针)

用 `scripts/capture-server.ts` 重新抓一份真实 CLI 的请求(头部+请求体都要),以它为基准做逐项消融:

1. **精确重放抓包** → 200,基准仍有效。
2. **换 UA(新/旧/垃圾)** → 新旧都过,垃圾 403。说明 UA 格式要求放宽了,不是这次的元凶。
3. **改 `x-opencode-session/request` 为 UUID 或删掉** → 403。ID 校验仍在,且是**严格形状校验**:前缀 + 恰好 26 字符(12 hex + 14 base62),25/27 字符都拒。
4. **删掉 tools / 只留 1 个 / 伪造 8-10 个** → 全部 403。**元凶找到**。
5. 继续细分:真实 11 个工具任换描述 → 过;真实 9-10 个 → 过;真实 5 个 → 过;**真实 2 个 → 拒**;伪造工具凑数 → 拒;追加客户端工具(哪怕放最前面)→ 过。

结论:**门槛是请求里必须包含足够多的 opencode 内置工具名**(11 个全带最稳);名字是硬校验,描述随便改,客户端自有工具可以追加。

### 4.2 修复(已实施)

- **`api/_lib/tools.ts`(新增)**:从真实 CLI 抓包逐字记录 11 个内置工具(`bash edit glob grep read skill task todowrite webfetch websearch write`)的完整定义。发送时描述替换为桩文案(`STUB_BUILTIN_TOOL_DESCRIPTION`),**防止模型自作主张调用客户端无法执行的 CLI 工具**(实测带真描述时模型会对普通问题自发调用 bash/read)。客户端声明的同名工具不覆盖内置定义。
- **`api/_lib/lower.ts`**:每次请求强制 `[...11 内置工具, ...客户端工具]`;`tool_choice` 强制为 `"auto"`(上游只支持 auto/省略,`none`/`required`/命名函数全部 400);新支持 `prompt_cache_key`(CLI 发的是会话 ID,代理用 `x-opencode-session` 同值)。
- **`api/_lib/types.ts`**:UA 更新为线上真实格式 `opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`——注意开源仓库 `request.ts` 里构造的是另一种格式(`opencode/${version}`),**以线上抓包为准**;`x-opencode-project` 固定为 `"global"`(真实 CLI 全局会话的值);`UpstreamTool` 增加 `strict` 字段。
- **`api/chat.ts`**:`accept: "*/*"`(与 CLI 一致);identity 先生成并传给 lower 以填充 `prompt_cache_key`。

### 4.3 验证

```bash
bun run test   # 81/81(新增内置工具集/桩描述/tool_choice 强制/prompt_cache_key 断言)
bun run smoke  # 真实上游双路径 200
bun run eval   # 16/16:多轮、真流式、xhigh 思考、web_search 循环、记忆探针
```

## 5. 第三轮事件(2026-10-13):session ID 的编码指纹

代理再次全挂,报错与第二轮同款(**403** + `FreeTierError`),但这次元凶既不是请求头也不是工具集,而是 **session ID 的编码方式**:同一个字符串形状,**ascending 与 descending 的命运相反**。

### 5.1 上游变化

- **客户端换代**:开源仓库 `github.com/anomalyco/opencode` 已是 **v2**(monorepo 版本 2.0.28,npm 包 **`@opencode/cli`**);旧的 `opencode-ai`(1.19.0)是 v1 线。
- **源码搬家**:请求构造 `packages/opencode/src/session/llm/request.ts` → **`packages/core/src/session/model-request.ts`**;ID 生成 `packages/opencode/src/id/id.ts` → **`packages/schema/src/identifier.ts`**。
- **端点迁移**:models.dev 目录里 opencode provider 的 API 基址从 `https://opencode.ai/zen/v1` 变成 **`https://opencode.ai/inference/v1`**。两条路径目前都能过门槛,不是本次元凶,但值得留意。
- **UA 形态**:线上抓包为 `opencode/latest/2.0.28/cli`(即 `opencode/<channel>/<version>/<client>`);v1 的 `ai-sdk/provider-utils/... runtime/bun/...` 后缀在 v2 里消失。新旧 UA 都仍被接受。
- **新增 session 头**:当前客户端把同一个 session id 同时挂在 `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `x-session-id` 四个名下,并新增 `traceparent` / `b3` 追踪头;`x-opencode-request` 已不再发送。实测这些头**都不是**门槛(`traceparent`/`b3`/`x-opencode-project: global` 全删仍 200),但为保持"与真实客户端不可区分",代理照发前四个。
- **内置工具改名**:`bash → shell`、`task → subagent`、`apply_patch → patch`,`todowrite` 被移除,新增 `question` / `execute`(Code Mode)。抓包里直连工具的正式形态是 12 个:`edit glob grep question read shell skill subagent webfetch websearch write execute`。

### 5.2 定位过程(二分法探针)

真实 CLI(v2.0.28)直连上游是**通的**,所以问题一定在"代理哪里不像"。以抓包为基准逐项消融:

1. **精确重放抓包** → 200,基准有效。
2. **UA / `x-opencode-project` / `traceparent` / `b3` / 逐个 session 头** 单删 → **全部 200**。头指纹这次不是元凶(四个 session 头全删才 403)。
3. **tools 全删 → 403;只留 1–5 个 → 403;留 ≥ 6 个 → 200**。工具**数量**门槛降到 **6**(第二轮是 2),名字集不再严格(`execute` 换成 `patch` 也能过),**描述与参数随便桩化都行**。
4. **session id 换成随机 base62 → 403;换成 ascending 形状 → 403**。**元凶锁定在 session id 的编码**。
5. 固定前缀只扫低 12 位:`0xFC0` 起全过,`0xFBF` 及以下全拒;再扫 counter:`1…63` 过,`64…4095` 拒;把时间戳换成 1975 年 / 2000 年 / 未来,**只要低 12 位达标照样过**。

结论:**门槛校验的是 session id 的「descending 编码 + 每毫秒计数器 ≤ 63」**,即 `Identifier.create(true)` 的 48 位时间分量的低 12 位必须 ≥ `0xFC0`;前缀/时间戳完全不参与校验。而代理原来生成的是 **ascending**(未取反)且 counter 取 `atMs % 0x1000`(均匀落在 0…4095),约 98% 的概率落进拒绝区——所以**必挂**。

### 5.3 修复(已实施)

- **`api/_lib/identity.ts`**:改用 `Identifier.create(true)` 的 descending 编码(`value = ~(ms<<12 | counter) & 0xffffffffffff`),并把 counter 从 `atMs % 0x1000` 换成由 seed 派生的 `1 + hash32(seed) % 63`(恒定落在 1…63)。"同一 (callId, role) 确定性生成"保持不变。
- **`api/_lib/types.ts`**:UA 更新为线上真实形态 `opencode/${channel}/${version}/${client}`,版本跟随当前 `@opencode/cli`(2.0.28,channel `latest`)。
- **四个门面(`chat.ts` / `responses.ts` / `messages.ts` / `_lib/oa-compat.ts`)**:补齐 `x-opencode-session-id` / `x-session-affinity` / `x-session-id`,与当前客户端一致。
- **测试**:`test/identity.test.ts` 新增"低 12 位必须 ≥ 0xFC0"的不变量扫描(300 组 seed/时间戳),并把时间戳编码断言改成按 descending 解码;`test/pipeline.test.ts` 的 UA 断言同步。

### 5.4 验证

```bash
bun run test       # 169/169
bun run typecheck  # tsc --noEmit 通过
bun run smoke      # 真实上游 200(流式 + 非流式)
```

### 5.5 怎么抓 v2 客户端的真实请求

`scripts/capture-server.ts` 的玩法(把 `OPENCODE_BASE_URL` 指向本地)只对 v1 有效:v2 的 provider 基址来自 models.dev + 远程配置,在 `opencode.json` 里覆盖 `provider.opencode.settings.baseURL` **不会生效**(会依旧直连线上)。可用本地 MITM:

1. 自签一个 CA,并签一张 `opencode.ai`(+`*.opencode.ai`)的服务器证书;
2. 起一个 HTTP 代理:收到 `CONNECT` 后做 TLS 终止(用上一步的证书),把请求头+体记录下来,再转发给真实上游;
3. 用 `HTTPS_PROXY=http://127.0.0.1:<port>` + `NODE_EXTRA_CA_CERTS=<ca.crt>` 跑 `opencode run -m opencode/muse-spark-1.3-contributor-free "say PONG"`(**`NO_PROXY=127.0.0.1`**,否则 CLI 自己的本地 server 流量也会被代理掉);
4. 取记录里的 `POST /inference/v1/responses` 作为消融基准。

抓包是**唯一权威**;源码只用来解释抓包。

## 6. 下次上游再更新时的排查清单(Cheat Sheet)

按序检查,命中即修:

1. **报错是否变了文案/状态码?** 收集当前 4xx 响应体,和 `api/_lib/errors.ts` 的映射对照。429→403 或新增 `FreeTierError` 字样 = 门槛升级信号。
2. **重抓基准(唯一权威)。** 用**当前版本真实 CLI** 抓一份完整请求(头+体)并精确重放确认 200。v1 客户端可用 `scripts/capture-server.ts`;v2 客户端的 provider 基址来自 models.dev/远程配置,配置覆盖不生效,**必须本地 MITM**(见第 5.5 节)。
3. **版本号过期?** 先确认跟的是哪条线:`@opencode/cli`(v2,仓库 `anomalyco/opencode`,线上 UA `opencode/latest/<version>/cli`)还是 `opencode-ai`(v1)。`npm view @opencode/cli version`,更新 `api/_lib/types.ts` 的 `OPENCODE_VERSION` / `OPENCODE_CHANNEL`。上游大版本发布后这几乎总是第一步。
4. **头指纹变了?** 对比抓包头与 `api/chat.ts` 发的头集合(新增头?删除头?UA 格式?)。注意:**仓库源码的 UA 构造可能与线上二进制不一致**,以抓包为准。
5. **ID 形状变了?** 两步走:(a) 对照 `packages/schema/src/identifier.ts` 的 `Identifier.create`(前缀、26 字符、**descending 取反**)更新 `api/_lib/identity.ts`;(b) **逐位扫描**——固定前缀只扫低 12 位(或 counter),找出上游接受的区间。2026-10-13 的门槛就是"低 12 位 ≥ 0xFC0":形状正确但 ascending 一样被拒,别只测长度和前缀。
6. **请求体指纹变了?(2026-09-18 新增此类)** 用抓包体做消融:删 tools / 换 tools / 加 `reasoning` / 改 `prompt_cache_key` / 首条 role 换 `system`,一次只改一项,找到被校验的新字段。内置工具清单存于 `api/_lib/tools.ts`,若 CLI 工具集变化则重抓刷新该数组。
7. **上游 API 支持面变了?** 例如 `tool_choice` 现在只支持 `"auto"`;留意 400 响应里的 `param` 字段直接指出被拒参数。
8. **报错文案 grep 不到?** 校验在闭源边缘服务里,别浪费时间翻 CLI 逻辑,专注完整模仿客户端指纹(头 + 体)。
9. **免费模型 ID 变了?** 留意 zen 模型目录与 `MODEL_ID`(`muse-spark-1.3-contributor-free`)。
10. 修复后按顺序跑 `bun run test` → `bun run smoke` → `bun run eval`,全绿再收工。

## 7. 行为与合规注意事项

- 指纹模仿的是**无凭据的免费匿名层**,按 IP 限额;请勿用于绕过付费或大规模滥用,上游随时可能再次收紧。
- 内置工具只以**桩描述**发送(名字是真的,描述声明不可用):模型不会自发调用客户端无法执行的 CLI 工具;代理的兼容性目标是让 OpenAI 客户端自己的工具调用正常工作。
- 代理无状态,不落盘任何会话数据;加密思考内容(`encrypted_content`)按上游要求原样回传以支持多轮思考回放。
- `MODEL_ID` 把所有请求映射到免费模型;如需接入其他模型,改 `api/_lib/types.ts` 的 `MODEL_ID` 并确认上游允许。
