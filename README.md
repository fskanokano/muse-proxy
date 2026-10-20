# muse-proxy

一个把 opencode zen 的免费模型包装成标准 OpenAI Chat Completions / Responses 与 Anthropic Messages API 的无状态代理,零运行时依赖,可部署到 Vercel 等 edge/Node 环境(实现本体在 `api/`;`supabase` 分支另维护同构的 Edge Function 部署)。

- **入站**:`POST /v1/chat/completions`(OpenAI `/v1/chat/completions` 兼容,支持流式 SSE 与聚合 JSON、工具调用、`reasoning_effort`)
- **入站**:`POST /v1/responses`(OpenAI `/v1/responses` Responses API 规范,支持流式 SSE 与聚合 JSON、工具调用,详见下文)
- **入站**:`POST /v1/messages`(Anthropic `/v1/messages` Messages API 规范,支持流式 SSE 与聚合 JSON、工具调用、thinking 块,详见下文)
- **出站**:按模型分格式路由(zen 边缘按格式路由,2026-09-24 起多轮探针确认;上游端点自 2026-10-14 从 `/zen/v1` 迁到 `/inference/v1`,2026-10-17 起 oa-compat 模型路由到新 catalog provider.api `/inference/openai/v1`,旧 `/inference/v1` chat 挂载虽仍可用但代理已不再使用):
  - `muse-spark-1.3-contributor-free` → **上游已弃用(2026-10-17)**;代理把它别名到 `deepseek-v4.1-flash-free`,走 `POST https://opencode.ai/inference/openai/v1/chat/completions`(oa-compat)。客户端请求的 muse id 保留回显,线上不再有 muse 的 Responses 端点
  - `anotherspark` 已无免费模型;`/v1/responses` 上游对全部免费模型回报 `ModelProtocolUnsupported`(2026-10-17 探针),Responses 直发路径整体退役
  - `mimo-v2.6-flash-free` → `POST https://opencode.ai/inference/openai/v1/chat/completions`(oa-compat;走 `/v1/responses` 上游直接 500)
  - `space-bunny-free` → `POST https://opencode.ai/inference/openai/v1/chat/completions`(oa-compat;走 `/v1/responses` 上游 401 `ModelError: not supported for format openai`)
  - `step-5-preview-free` → oa-compat 同上(**2026-10-17 实测上游已下线**;2026-10-19 起与 muse 同处理:`upstreamId` 别名到 `deepseek-v4.1-flash-free`,id 保留供历史客户端解析,不再上架 `/v1/models`)
  - `deepseek-v4.1-flash-free` → `POST https://opencode.ai/inference/openai/v1/chat/completions`(oa-compat;走 `/v1/responses` 上游 400 `ModelProtocolUnsupported: Model does not support this protocol`,2026-10-16/17 探针)
  - `glm-5.3-flash-free` → `POST https://opencode.ai/inference/openai/v1/chat/completions`(oa-compat;2026-10-16 探针 `/v1/responses` 400 `ModelProtocolUnsupported`,同 deepseek)
  - `big-pickle` / `longcat-2.5-preview-free` / `beam-free` / `nemotron-3.5-lightning-free` / `nemotron-3-ultra-free` / `nemotron-3.5-super-vl-free` → 2026-10-19 接入的六个存活免费档,全部 oa-compat 同上(chat/completions;`/v1/responses` 一律 400 `ModelProtocolUnsupported`),详见「模型目录」
  - `muse-spark-1.3-contributor-goal` → 与 muse 相同:**别名到 deepseek,走 oa-compat**(goal 的 judge/续轮也共用同一 oa-compat mount + 指纹;门禁要求 `stream:true`,judge 改为流式聚合)
- **鉴权**:`Authorization: Bearer $PROXY_API_KEY` 或 `x-api-key: $PROXY_API_KEY`(三个端点共用同一鉴权逻辑)。**未设置 `PROXY_API_KEY` 环境变量时,所有端点一律返回 401(fail-closed),不存在开放模式**
- **免费模型**:上游 API key 固定为字面量 `public`,匿名免费层按 IP 限额,无需注册
- **模型路由**(`api/_lib/types.ts` 的 `resolveModel`):显式匹配 `mimo*`/`deepseek*`/`glm*`/`longcat*`/`beam*`/`nemotron*`/`space-bunny*`/`step-5*`/`muse*` 前缀与完整 id(`nemotron` 再按 `ultra`/`super-vl` 限定符分流,余者落 Lightning;`big-pickle` 亦直连);`muse*`/`step-5*`/goal 与其余任意未知 id 一律别名到 `deepseek-v4.1-flash-free`(2026-10-17/19 起 muse 弃用、step-5 退休,永不报 404);三个端点对同一 model id 语义一致
- **思考强度**:逐档位实测上游接受度(2026-09-24 起,`scripts/probe-reasoning-efforts.ts`),`/v1/models` 每个模型暴露 `reasoning` + `reasoning_levels`:
  - `muse-spark-1.3-contributor-free`:**已别名到 deepseek**,档位继承 deepseek 规则 `low/high/max`(`none` 钳制为 `low`);原 muse 档位(`none/minimal/low/medium/high/xhigh`,`max` 上游 400)随弃用作废;Anthropic 门面 `thinking.budget_tokens` 档位映射不变
  - `mimo-v2.6-flash-free`:reasoning **恒开**,`reasoning_effort` 上游容忍但无效,故不暴露档位、不下发该字段
  - `space-bunny-free`:`minimal/low/medium/high/xhigh/max`(目录外还多接受 `minimal`);请求 `none` 会被钳制为 `minimal`(直接转发上游 400);Anthropic 门面 `thinking:{type:"disabled"}` 同样钳制为 `minimal`
  - `step-5-preview-free`:`low/high/max`(2026-10-17 上游下线后随 `upstreamId` 别名继承 deepseek 档位;原 `minimal..max` 白名单作废)
  - `deepseek-v4.1-flash-free`:`low/high/max`(上游目录 `reasoning_options` 原样;实测任意档位上游都 200,但未文档化的档位代理**丢弃**而非猜测转发,`none` 钳制为 `low`)
  - `glm-5.3-flash-free`:`low/high/max`(同 deepseek 规则:目录档位原样转发,未文档化档位丢弃,`none` 钳制为 `low`)
  - `big-pickle` / `longcat-2.5-preview-free` / `nemotron-3.5-lightning-free` / `nemotron-3-ultra-free`:reasoning 恒开但目录只给 `toggle`/空档位 → 不暴露档位、不下发该字段(同 mimo)
  - `beam-free`:`low/medium/high/xhigh/max`(目录档位原样;`none` 钳制为 `low`,未文档化档位丢弃)
  - `nemotron-3.5-super-vl-free`:`none/minimal/low/medium/high/xhigh`(唯一把 `none` 写进目录的免费条目,`none` 原样转发不钳制)
  - 钳制逻辑集中在 `clampEffortForModel`(`api/_lib/types.ts`),三个门面共用

```
client ──chat/completions──▶ muse-proxy ──alias(muse*/step-5*/goal/未知 → deepseek)──┐
        ◀──SSE chunks────               └─oa-compat────▶ opencode zen /inference/openai/v1/chat/completions (mimo / space-bunny / deepseek / glm / big-pickle / longcat / beam / nemotron ×3)
                                                          └─raise─▶ 同一套 raise 层(gate:stream=true,goal judge 流式聚合)
```

新增的 oa-compat 模型(`api/_lib/chat-upstream.ts` + `api/_lib/oa-compat.ts`):降级(Responses input → chat messages,含 function_call 轮次回放：连续并行调用合并成一条 `assistant(content=null, tool_calls=[...])`，拆散上游直接 400)与升格(chat-completions SSE → 规范 Responses 事件生命周期:`response.created` → `output_item.added` → 文本/思考 delta → `output_text.done`/`output_item.done` → `response.completed`),三个门面共享同一转换层,语义(工具暴露、心跳、终止事件守护)全部一致;assistant 历史回放保留可见推理(`reasoning_content`),deepseek 类模型缺失时补空串——thinking mode 缺该字段上游直接 400(见 deepseek 节)。2026-10-17 起 **muse 也走这条路径**(别名到 deepseek),`lower.ts` 直发 `/inference/v1/responses` 的分支退役;对 OpenMinis Responses 解析器补齐的 function-call 事件顺序(`output_item.added` → `function_call_arguments.delta` → `function_call_arguments.done` → `output_item.done`)保留。`/v1/models` 目录共 11 条(10 个存活免费档 + 1 个 goal 实验模型;muse / step-5 两个退役 id 已下架但保留解析)。

## 模型目录

代理当前上架 **11 个模型**(2026-10-19 复核后的 10 个存活免费档 + 1 个 goal 实验模型;muse / step-5 两个上游退役 id 保留解析但已下架)。`GET /v1/models`(`api/models.ts`)按 OpenAI models-list 格式返回下表全部**上架**模型,每个条目携带 `reasoning`(是否思考)与 `reasoning_levels`(支持的思考强度档位,空数组 = 无档位控制)元数据,另有 `context_window` / `max_output_tokens` / `owned_by: "opencode-zen"`。所有模型共享免费匿名层:上游 API key 固定为字面量 `public`,按 IP 限额,无需注册;三个 API 门面(chat / responses / messages)对同一 model id 语义一致。

| 模型 ID | 名称 | 上游格式(出站路由) | 上下文窗口 | 最大输出 | 思考 | 思考强度档位 |
|---|---|---|---|---|---|---|
| `muse-spark-1.3-contributor-free` | Muse Spark 1.3 Contributor Free(已别名到 deepseek) | **oa-compat** → deepseek(2026-10-17 起,muse 上游弃用) | 200,000 | 32,000 | ✅ | `low / high / max`(`none` 钳制为 `low`;原 muse 档位作废) |
| `mimo-v2.6-flash-free` | MiMo-V2.6-Flash Free | `oa-compat` → `POST https://opencode.ai/inference/openai/v1/chat/completions` | 200,000 | 32,000 | ✅ 恒开 | 无(上游容忍 `reasoning_effort` 但无效,代理不下发该字段) |
| `space-bunny-free` | Space Bunny Free | `oa-compat` → `POST https://opencode.ai/inference/openai/v1/chat/completions` | 1,048,576 | 32,000 | ✅ 恒开 | `minimal / low / medium / high / xhigh / max`(`none` 钳制为 `minimal`,直接转发上游 400) |
| `step-5-preview-free` | Step 5 Preview Free(已别名到 deepseek,**不再上架**) | **oa-compat** → deepseek(2026-10-17 上游下线,2026-10-19 起别名) | 200,000 | 32,000 | ✅ | `low / high / max`(`none` 钳制为 `low`,同 deepseek) |
| `deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash Free | `oa-compat` → `POST https://opencode.ai/inference/openai/v1/chat/completions` | 200,000 | 32,000 | ✅ | `low / high / max`(`none` 钳制为 `low`;其余未文档化档位丢弃) |
| `glm-5.3-flash-free` | GLM-5.3-Flash Free | `oa-compat` → `POST https://opencode.ai/inference/openai/v1/chat/completions` | 200,000 | 32,000 | ✅ | `low / high / max`(`none` 钳制为 `low`;其余未文档化档位丢弃) |
| `big-pickle` | Big Pickle | `oa-compat` → 同上(chat/completions) | 200,000 | 32,000 | ✅ 恒开 | 无(目录 `reasoning_options` 为空) |
| `longcat-2.5-preview-free` | LongCat 2.5 Preview Free | `oa-compat` → 同上 | 1,000,000 | 32,000 | ✅ 恒开 | 无(目录只给 `toggle`) |
| `beam-free` | Beam Free | `oa-compat` → 同上 | 1,048,576 | 32,000 | ✅ | `low / medium / high / xhigh / max`(`none` 钳制为 `low`) |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | `oa-compat` → 同上 | 262,144 | 32,000 | ✅ 恒开 | 无(目录 `reasoning_options` 为空) |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra Free | `oa-compat` → 同上 | 1,000,000 | 32,000 | ✅ 恒开 | 无(目录 `reasoning_options` 为空) |
| `nemotron-3.5-super-vl-free` | Nemotron 3.5 Super VL Free | `oa-compat` → 同上 | 1,048,576 | 32,000 | ✅ | `none / minimal / low / medium / high / xhigh`(`none` 原样转发) |
| `muse-spark-1.3-contributor-goal` | Muse Spark 1.3 Contributor Goal(已别名到 deepseek) | **oa-compat** → deepseek(同 muse;goal judge 流式聚合) | 200,000 | 32,000 | ✅ | `low / high / max`(`none` 钳制为 `low`,同 muse) |

### muse-spark-1.3-contributor-free(2026-10-17 起别名到 deepseek)

- **定位**:曾为默认模型、唯一走 Responses 上游路的模型;zen 边缘现已弃用(真实流式请求回报 `Model muse-spark-1.3-contributor-free has been deprecated.`)。为保住依赖 muse id 的客户端,**代理不再直发 muse**,而是把请求(lower 后的统一 body)别名到 `deepseek-v4.1-flash-free` 走 oa-compat chat 上游;下游回显保留客户端请求的 muse id。
- **别名**:`model id 含 "muse"` 即匹配(如 `muse`、`muse-spark-1.3`;goal id 走 goal 分支后同样落到 deepseek);**任意未知 model id 也回落到这里**,再经别名落到 deepseek——历史"永不 404"行为不变。
- **思考**:别名后档位按 deepseek 目录 `low/high/max`(`clampEffortForModel` 对 muse 返回 deepseek 档位;`none` 钳制为 `low`)。原 muse 加密思考回放(`encrypted_content` / `reasoning_details`)随上游弃用作废;Anthropic 门面 `thinking.budget_tokens` 档位映射不变。
- **路由格式**:`oa-compat`,与 mimo/deepseek/glm 共用同一 `OaCompatRaiser` 升格层;上游端点为 catalog 新 `provider.api` 挂载 `/inference/openai/v1/chat/completions`。
- **定义处**:`api/_lib/types.ts` 的 `MUSE_INFO`(`upstreamId: MODEL_DEEPSEEK`)。

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

### step-5-preview-free(2026-10-19 起别名到 deepseek,不再上架)

- **定位**:Step 5 限时预览推理模型;2026-10-17 实测 zen 边缘下线(两个挂载一致返回 `Upstream request failed: Model is unavailable.`),2026-10-19 复核未恢复,于是按 muse 的同一处理把 id 留在 `MODELS`、`upstreamId` 别名到 `deepseek-v4.1-flash-free`——依赖 step-5 id 的客户端从「必报错」变成「可用」,同时从 `/v1/models` 下架,不再广告必挂的条目。
- **别名**:`model id 包含 "step-5"` 或以 `step5` 开头即匹配。
- **思考**:随别名继承 deepseek 档位 `low/high/max`(`none` 钳制为 `low`);原「必开 + `minimal..max`」白名单随上游下线作废。
- **路由格式**:`oa-compat`(chat completions)。
- **定义处**:`api/_lib/types.ts` 的 `STEP5_INFO`(`upstreamId: MODEL_DEEPSEEK`)。

### deepseek-v4.1-flash-free

- **定位**:DeepSeek V4.1 Flash,面向推理与 agentic coding(免费层,catalog `release_date` 2026-09-10)。
- **别名**:`model id 以 "deepseek" 开头(大小写不敏感)`即匹配——包含 zen 付费目录名(如 `deepseek-v4-flash`)与其它 deepseek id,全部由免费 V4.1 Flash 变体服务(同 mimo 的处理方式)。
- **思考**:流式为 `delta.reasoning_content`(catalog 的 `interleaved.field` 原样;`OaCompatRaiser` 同时兼容 `reasoning`);档位取 catalog 的 `reasoning_options` = `low/high/max`。
- **路由格式**:`oa-compat`(chat completions)且**仅此一种**——2026-10-16 探针(`scripts/probe-deepseek-routing.ts`)实测 `/inference/v1/responses` 返回 400 `ModelProtocolUnsupported: Model does not support this protocol`,同一 body 打到 chat completions 挂载返回 200(2026-10-17 起 catalog `provider.api` 换到 `/inference/openai/v1`,代理同步迁移)。
- **能力**:工具调用、图片输入(`attachment`)、`temperature`、结构化输出均可用;`context 200,000` / `output 32,000`(`models.opencode.ai/api.json` 的 `opencode/deepseek-v4.1-flash-free`)。
- **多轮回放**:thinking mode 要求历史 assistant 消息逐条携带 `reasoning_content`;只要出现 `reasoning_content` / 工具轮,后续断言消息缺失即 400 `The reasoning_content in the thinking mode must be passed back to the API`(实测**间歇性**触发,重试时好时坏)。代理在 `lower.ts` 保留客户端回放的可见推理,`responses` 的 reasoning summary、`messages` 的 thinking 块同样转成该字段,并在 `chat-upstream.ts` 对 deepseek 类模型的每条 assistant 消息缺失时补空串(与 opencode `requireReasoning` 行为一致);`encrypted_content` / 签名 blob 仍丢弃(会话绑定,换会话必被上游拒绝)。
- **定义处**:`api/_lib/types.ts` 的 `DEEPSEEK_INFO`。

### glm-5.3-flash-free

- **定位**:GLM-5.3-Flash,原生多模态 GLM(`text/image/video/pdf` 输入),面向高效编码与长时程 agent 任务(免费层,catalog `release_date` 2026-08-26)。
- **别名**:`model id 以 "glm" 开头(大小写不敏感)`即匹配——包含 zen 付费目录名(`glm-5.3-flash`、`glm-5`、`glm-4.7` 等)与旧免费名(`glm-5-free`/`glm-4.7-free`),全部由免费 GLM-5.3-Flash 变体服务(同 mimo/deepseek 的处理方式)。
- **思考**:流式为 `delta.reasoning_content`(catalog 的 `interleaved.field` 原样;`OaCompatRaiser` 同时兼容 `reasoning`);档位取 catalog 的 `reasoning_options` = `low/high/max`。
- **路由格式**:`oa-compat`(chat completions)且**仅此一种**——2026-10-16 探针(`scripts/probe-deepseek-routing.ts glm-5.3-flash-free`)实测 `/inference/v1/responses` 返回 400 `ModelProtocolUnsupported: Model does not support this protocol`,同一 body 打到 chat completions 挂载返回 200(2026-10-17 起 catalog `provider.api` 换到 `/inference/openai/v1`,代理同步迁移)。
- **能力**:工具调用、图片输入(`attachment`)、`temperature`、结构化输出均可用;`context 200,000` / `output 32,000`(`models.opencode.ai/api.json` 的 `opencode/glm-5.3-flash-free`;目录还带 `canonical_model_id: zhipuai/glm-5.3-flash`)。
- **定义处**:`api/_lib/types.ts` 的 `GLM_INFO`。

> `muse-spark-1.3-contributor-free` 与 `step-5-preview-free` 因上游退役(muse 410 `ModelDeprecated`、step-5 400 `Model is unavailable.`)已从 `/v1/models` 下架(`MODELS` 里 `listed: false`),但 id 仍可解析——请求它们会经 `upstreamId` 落到 `deepseek-v4.1-flash-free`,保留历史客户端「永不 404」的契约。

### 2026-10-19 新增的六个存活模型(big-pickle / longcat / beam / nemotron ×3)

条目全部取自 `models.opencode.ai/api.json` 的 `opencode.models`(`id` / `name` / `limit` / `reasoning_options` / `interleaved` / `attachment` / `tool_call` / `cost` 逐字段对照),`cost` 全 0 的存活条目无一遗漏;六个 id 的 `provider.api` 均为 `/inference/openai/v1`,与其他免费档共用 oa-compat chat 挂载(不新增任何转换路径);广告的 `max_output_tokens` 与其它条目一致取 `OUTPUT_TOKEN_MAX`(32,000):

- `big-pickle`(`BIG_PICKLE_INFO`):目录里唯一不带 `-free` 后缀的存活免费条目(成本 0/0/0);`reasoning_options` 为空 → 不下发 `reasoning_effort`;文本输入、工具调用 + 结构化输出。
- `longcat-2.5-preview-free`(`LONGCAT_INFO`):美团 LongCat 2.5 预览版,1M 上下文、图片输入、多模态推理;目录只给 `toggle` → 不下发档位。
- `beam-free`(`BEAM_INFO`):稀疏 MoE(23B 激活参数),档位 `low/medium/high/xhigh/max`,`none` 钳制为 `low`。
- `nemotron-3.5-lightning-free`(`NEMOTRON_LIGHTNING_INFO`):NVIDIA 快速 MoE,262,144 上下文;`reasoning_options` 为空 → 不下发档位。
- `nemotron-3-ultra-free`(`NEMOTRON_ULTRA_INFO`):最大号 Nemotron 3(1M 上下文);同样不下发档位。
- `nemotron-3.5-super-vl-free`(`NEMOTRON_SUPER_VL_INFO`):视觉语言推理(text + image 输入);目录档位 `none/minimal/low/medium/high/xhigh`——唯一把 `none` 写进目录的免费条目,代理原样转发。

目录里带 `deprecated` 标记的 id(`cat-jam-free` / `exo-free` / `x-preview-f-free` 等)在退役过渡期,暂不入目录:它们随时可能硬退,`resolveModel` 的未知 id 兜底(别名 deepseek)已保证请求不 404;哪天 zen 真要留某个 id,按 §7.2 四步原样补即可。

> 上表的档位接受度均以目录 `reasoning_options` 为准(deepseek/glm 2026-10-16 逐档实测后按目录收窄;muse/step-5 别名后沿用 deepseek 档位 2026-10-17/19;mimo/space-bunny 2026-09-24 起;big-pickle/longcat/beam/nemotron 三兄弟 2026-10-19 按目录字段录入)。路由与钳制逻辑集中在 `api/_lib/types.ts`(`resolveModel` / `clampEffortForModel`),三个门面共用;新增模型时先更新 `MODELS` 目录,再跑 `bun run smoke:newmodels` 与 `bun run smoke:efforts`(详见 §7.2)。

---

## 快速开始

```bash
bun install            # 或 npm install
bun run test           # 195 个单元/集成/沙箱端到端测试(mock 上游,无需联网)
bun run smoke          # 真实连通性冒烟(需联网,验证 stream:false 与 stream:true)
bun run smoke:responses # /v1/responses 真实上游全功能冒烟(需联网,7 项 36 检查)
bun run smoke:messages  # /v1/messages 真实上游全功能冒烟(需联网,8 项任务)
bun run smoke:newmodels # oa-compat 模型 × 三门面全链路真实上游冒烟(需联网,9 项任务 × 11 模型 + muse 回归)
                       #   矩阵较大,可分片跑:bun run smoke:newmodels glm-5.3-flash-free --steps=chat,chat-stream,responses,responses-stream
bun run smoke:efforts  # 思考强度档位真实上游冒烟:/v1/models 元数据 + 8 模型档位端到端 + none 钳制
bun run smoke:tools    # agent 工具循环真实上游冒烟:3 模型 × 3 门面,流式 tool call → 执行 → 回传 → 结果落地
bun run smoke:openminis # OpenMinis file_write 真实上游探针:3 门面 × 5 个参数的全量回放 + 模型生成工具调用
bun run eval           # 完整 agent 评测:xhigh 思考 + web_search 工具循环 + 3 轮多轮对话
bun run typecheck
```

---

---

## OpenAI Responses 端点:`POST /v1/responses`

除 chat completions 门面外,代理还直接暴露 OpenAI **Responses API** 规范端点(`api/responses.ts`,Vercel rewrite `/v1/responses → /api/responses`)。上游本来就是 Responses API,因此该端点是**归一化 + 指纹修补**模式,与 chat 端点完全独立、互不影响(不共享可变逻辑;`lower.ts`/`chat.ts` 未被改动)。

```bash
curl -X POST https://your-proxy/v1/responses \
  -H "Authorization: Bearer $PROXY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"anything","input":"hi","stream":false}'
```

支持范围:

- `input`:字符串,或数组项 `{role, content}` / `{type:"message"}`(user 支持 `input_text`/`input_image` parts,assistant 支持 `output_text`)、`{type:"function_call"}`、`{type:"function_call_output"}`、`{type:"reasoning"}`(加密 blob 丢弃、可见 summary 文本回放为 `reasoning_content`)
- `instructions`:转为首条 system 消息;`reasoning.effort`:白名单同 chat 端点(默认 `high`)
- `tools`:Responses 扁平 function 工具(误传 chat 嵌套形状也兼容),追加在内置工具之后
- `stream:true`:按 Responses 流式规范以 `event: <type>` + `data: <json>` 帧逐事件透传上游事件(不发 `[DONE]`,与 OpenAI Responses 流式一致),带心跳注释;oa-compat 模型会合成完整 function-call 生命周期(`output_item.added`、`function_call_arguments.delta/done`、`output_item.done`),兼容 OpenMinis 等严格 Responses 客户端;上游混入的非规范 `ping` 保活帧被过滤(`response.completed` 始终是终止事件);若上游未发终止事件就断流,合成 `error`(`upstream_stream_truncated`)事件再关闭,截断不会被误当成正常完成
- `stream:false`:聚合为单个 `response` 对象(`object:"response"`、`output`、`output_text`、`usage`、`status: completed/incomplete`);上游断流未发终止事件时返回 502 `upstream_stream_truncated`,绝不把截断输出标成 `completed`

有意的限制(免费层契约):

- **无状态**:`previous_response_id` 非空直接 400,请把完整对话放进 `input`
- `store` 恒为 `false`,`include` 恒为 `["reasoning.encrypted_content"]`;`encrypted_content` 永不回放(会话绑定),reasoning 项的 summary 文本会回放到对应 assistant 的 `reasoning_content`
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

- `messages`:`content` 为字符串或内容块;user 支持 `text`/`image`(base64 与 url source)/`tool_result` 块,assistant 支持 `text`/`tool_use` 块;assistant `thinking` 块回放为 `reasoning_content`(signature 无法复用,只带文本),user `thinking` 块丢弃
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

> 免费层不是按账号鉴权的,而是**按客户端指纹鉴权**。opencode zen 一旦收紧指纹校验,代理立刻失效——这不是 bug,是设计如此。本文记录四轮完整的排查-定位-修复过程(第一轮:头指纹;第二轮:请求体工具集指纹;第三轮:session ID 编码指纹;第四轮:内置工具逐字定义 + 别名),外加两轮非门槛类变更(端点迁移/模型目录变更与 muse 弃用退役),上游下次再变时照此办理。

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

## 6. 第四轮事件(2026-10-14):内置工具的定义指纹 + 客户端工具别名

门槛第三次升级:这次校验的是 `tools` 数组里内置工具的**逐字定义**(描述 + 参数 schema),
并且把“同名遮蔽”也堵死了。修复后顺手把三方真实 CLI 全部实测了一遍。

### 6.1 上游变化

- **12 个内置工具的定义逐字校验**:`edit glob grep question read shell skill subagent webfetch websearch write execute`。
  描述或 `parameters` 与真实客户端不一致即 403 `FreeTierError`;小截断(尾部几百字符)仍可过,**桩描述彻底不行**。
- **退役名被拉黑**:`bash` / `task` / `todowrite` 只要出现在 `tools` 里就 403,即使定义与旧版一致。
- **同名遮蔽失效**:客户端工具复用内置名(pi 的 `read`/`edit`/`write`、pf 的 `shell`)→ 403;
  “同名替换内置项”的旧规则不再被接受。
- **额外工具仍可追加**(任意名字、任意数量、顺序无关),门面继续把客户端工具排在 12 个内置之后。

### 6.2 修复(已实施):别名 `mp_<name>`

- **`api/_lib/tools.ts`**:内置定义改为**逐字下发**(不再桩化);保留名集合 =
  12 个内置 + 退役的 `bash`/`task`/`todowrite`。客户端工具命中保留名时以 `mp_<name>` 别名追加
  (定义不动,只改名字),其余客户端工具原样追加。
- **下行映射**:四个门面在把上游 `function_call` 转成客户端事件时先 `exposedToolName()` 把 `mp_<name>`
  还原成客户端原名(`api/chat.ts` / `_lib/raise.ts` / `api/messages.ts` / `_lib/messages-raise.ts` /
  `api/responses.ts` 的聚合与两条流式路径,流式侧另有 `exposeUpstreamNames` 重写 forwarded 帧),再做暴露判定;
  `shouldExposeToolCall` 同时接受原名与别名,客户端声明的名字一律暴露,未声明的保留名一律隐藏。
- **响应体 tools 回显**:流式 `response.created`/`response.completed` 里上游回显的是**注入后的**工具表
  (内置 + `mp_*`);门面把它重写成客户端自己声明的工具(原名,注入的内置不外泄),同名时客户端的定义胜出。
- **模型侧行为**:`bash` 这类上游已无同义内置的名字,模型只能看到 `mp_bash`;这也是**别名不能改成丢弃**的原因
  ——丢弃后客户端就没有 shell 能力了。实测 pi 的请求(工具 `read`/`bash`/`edit`/`write`)从 403 `upstream_auth`
  变成 200,模型调 `mp_bash`,下行还原为 `bash`。

### 6.3 验证:三个真实 CLI 全链路

| 客户端 | 端点 | 实测结果 |
| --- | --- | --- |
| codex 0.162.1 | `POST /v1/responses` | 12 内置 + 12 客户端工具;`exec_command` 调用 → 本地执行 → 最终答案正确 |
| pi 1.2.0 | `POST /v1/chat/completions` | `bash` 写文件→ `read` 回读内容正确 → `edit` 两轮收敛,文件内容被改写 |
| Claude Code 2.1.299 | `POST /v1/messages` | 20 个客户端工具(大写名不撞内置,零别名);`Bash` → `Read` → DONE |

方法:本地起门面 handler(真上游、真 SSE),用真实 CLI 自己的配置指向它,断言副作用(文件内容)+ 门面日志里的工具调用名。
另外用保留名 `shell` 直击三个门面,确认真上游 200、模型真的调用了 `mp_shell`,且下行只暴露 `shell`。

验证:

```bash
bun run test      # 188/188(test/tools.test.ts 钉住别名原语,test/alias-downlink.test.ts 钉住三门面回环)
bun run typecheck # tsc --noEmit 通过
```

## 7. 2026-10-16 复核:源码再搬家 + 新模型接入(deepseek-v4.1-flash-free / glm-5.3-flash-free)

这一轮上游**没有**升级门槛(指纹一字未改),但做了三件事:重拉 opencode 源码、同步版本号、接入新的免费模型(同一天两个:deepseek 见 7.2/7.3,glm 见 7.5)。

### 7.1 重拉源码后发现的变化

```bash
cd ~ && git clone --depth 1 https://github.com/anomalyco/opencode opencode   # dev 分支,本次 tip e25b7ab
```

- **npm 包版本 2.0.29 → 2.0.30**(`npm view @opencode/cli version`;`packages/cli/package.json` 同值)。实测 2.0.29 与 2.0.30 的 UA 都能过闸门,代理照旧跟随 npm latest。
- **请求构造再搬家**:`packages/opencode/src/session/llm/request.ts` → **`packages/core/src/session/model-request.ts`**;UA 构造仍在 `packages/core/src/app.ts` 的 `useragent()`,格式未变。
- **头集合未变**(`model-request.ts` 的 `headers`):`x-opencode-session-id` / `x-session-affinity` / `X-Session-Id` / `x-opencode-project` / `x-opencode-session` / `x-opencode-client` / `User-Agent`(+ 子会话时的 parent 头),**仍无 `x-opencode-request`** —— 与代理目前发的四种 session 别名完全一致。
- **内置工具集未变**:`packages/core/src/tool/plugin/*.ts` 仍是 `edit glob grep question read shell skill subagent webfetch websearch write`(加上 `codemode/tool.ts` 的 `execute`),即 `_lib/tools.ts` 里逐字下发的 12 个;带旧定义的实测请求依旧 200,无需重抓。

结论:**本轮只同步 `OPENCODE_VERSION`**,头/ID/工具定义一律不动。

### 7.2 新模型接入(deepseek-v4.1-flash-free)

新模型入目录的固定四步(照此办理):

1. **读目录**:从 `https://models.opencode.ai/api.json` 的 `opencode.models` 取条目(id / name / limit / reasoning_options / interleaved / attachment / tool_call / cost)。
2. **探路由**:跑 `bun run scripts/probe-deepseek-routing.ts[模型 id]`——同一份过闸门 body 分别打 `/inference/v1/chat/completions` 与 `/inference/v1/responses`,看哪个返回 200。deepseek 只活在前者(`ModelProtocolUnsupported` 只在后者出现);要逐档位看的话加 `PROBE_EFFORTS=1`。
3. **写目录**:`api/_lib/types.ts` 新增 `MODEL_DEEPSEEK` / `DEEPSEEK_INFO`、`MODELS` 加一行、`resolveModel` 加别名(catalog 文档里只列 `low/high/max`,即使上游对其它档位也 200,代理也不猜——未文档化档位丢弃,`none` 钳制到目录最低档 `low`)。
4. **开思考标记 + 测试**:`api/models.ts` 的 `REASONING_MODELS` 加 id(使 `/v1/models` 的 `reasoning:true` 成立),并同步 `test/chat-upstream.test.ts` 的目录断言与 `test/pipeline.test.ts` 的 UA 断言(本分支无 `test/router.test.ts`)。

三个门面无需任何改动:路由分发统一看 `resolveModel(...).upstream === "oa-compat"`(`chat.ts` / `responses.ts` / `messages.ts` 各一处),新增 oa-compat 模型自动获得 chat / responses / messages 三门面支持。

### 7.3 验证(全部真实上游)

```bash
bun run test                                                        # 215/215
bun run typecheck                                                   # tsc --noEmit 通过
bun run scripts/probe-deepseek-routing.ts                           # oa-compat 200 / responses 400 ModelProtocolUnsupported
bun run smoke:newmodels deepseek-v4.1-flash-free --steps=chat,chat-stream,responses,responses-stream
bun run smoke:newmodels deepseek-v4.1-flash-free --steps=messages,messages-stream,tools,memory
bun run smoke:newmodels deepseek-v4.1-flash-free --steps=large      # 各轮内附 muse 回归
bun run smoke:newmodels mimo-v2.6-flash-free                        # 回归:mimo 全量
bun run smoke:newmodels space-bunny-free step-5-preview-free        # 回归:其余 oa-compat 模型全量
bun run smoke:tools                                                 # 164/164:3 模型 × 3 门面工具回合
bun run smoke:efforts                                               # 22/22:含 deepseek 全档位

```

### 7.4 GitHub 上的三线同步(egress / supabase / main)

三个分支共享同一套门面实现,只是宿主不同,新模型必须**三线同时落地**,否则客户端把 base_url 指到另一条线时模型凭空消失:

| 分支 | 形态 | 本分支额外内容 | 同步方式 |
|---|---|---|---|
| `main` | Vercel 部署 | `api/*` 兼容外壳 + `api/_lib/*`(实现本体) | 把本轮的 `_lib/types.ts` / `models.ts` / UA 常量 / 测试 / README 改动 cherry-pick 或手工对齐到 `api/` 下的同名文件 |
| `supabase` | Supabase Edge Function | `supabase/functions/muse-proxy/*` + `api/*` 外壳 | 与 egress 的 `supabase/` 树同源,直接对齐 |
| `egress` | 本机常驻(Docker) | 额外 `server/`(出口 IP 轮询)+ `admin-web/` | 以本分支为准 |

> 切分支后发现“模型消失了”,先对 `git diff origin/<分支>..<分支> -- '*types.ts'`,确认目录同步到位再怀疑上游。

### 7.5 同轮第二个模型:glm-5.3-flash-free

按 7.2 的四步原样再走一遍(新模型入目录流程已被第二次验证,四个改动点一个不多):

1. **读目录**:`opencode/glm-5.3-flash-free` —— family `glm-flash`、`release_date` 2026-08-26、`reasoning_options [{type:"effort",values:["low","high","max"]}]`、`interleaved.field: "reasoning_content"`、`attachment/tool_call/structured_output/temperature` 均 true、输入 `text/image/video/pdf`、`limit 200000/32000`、cost 全 0。
2. **探路由**:`bun run scripts/probe-deepseek-routing.ts glm-5.3-flash-free` → oa-compat 200(`text="PONG"`,思考走 `reasoning_content`)/ responses 400 `ModelProtocolUnsupported`;`PROBE_EFFORTS=1` 下 `none..max` 七档全部 200(与 deepseek 同形),但目录只写 `low/high/max`,故代理只转发这三档。
3. **写目录**:`api/_lib/types.ts` 新增 `MODEL_GLM` / `GLM_INFO`、`MODELS` 加一行、`resolveModel` 加 `glm*` 别名(大小写不敏感,含付费/旧免费 glm id);`api/models.ts` 的 `REASONING_MODELS` 加 id。
4. **测试/脚本**:`test/chat-upstream.test.ts`(档位钳制 + 别名 + 目录顺序 + `reasoning_levels`)与 `test/pipeline.test.ts`(UA 断言)同步;`scripts/smoke-newmodels.ts` 的 `MODELS`、`scripts/smoke-efforts.ts` 的档位矩阵与元数据断言均加 glm。本分支没有 `test/router.test.ts` / `scripts/mp-smoke.ts`(那是 egress/supabase 侧的门面与运行时测试)。

三个门面、上游转换层(`chat-upstream.ts` / `oa-compat.ts`)、指纹(UA/头/工具)一律不动:glm 与 deepseek 同属 oa-compat 路径,复用同一套降级/升格。

验证(全部真实上游,与 7.3 同口径):

```bash
bun run test                                            # 216/216
bun run typecheck                                       # tsc --noEmit 通过
bun run scripts/probe-deepseek-routing.ts glm-5.3-flash-free   # oa-compat 200 / responses 400
PROBE_EFFORTS=1 bun run scripts/probe-deepseek-routing.ts glm-5.3-flash-free   # none..max 七档均 200
bun run smoke:newmodels glm-5.3-flash-free --steps=chat,chat-stream,responses,responses-stream
bun run smoke:newmodels glm-5.3-flash-free --steps=messages,messages-stream,tools,memory
bun run smoke:newmodels glm-5.3-flash-free --steps=large       # 各轮内附 muse 回归
bun run smoke:efforts                                          # 含 glm 全档位

```

实测记录(2026-10-16,真实上游):

- `smoke:newmodels glm-5.3-flash-free` 九步全过(chat / chat-stream / responses / responses-stream / messages / messages-stream / tools / memory / large,每轮含 muse 回归)。免费层按 IP 限额,**连续快速调用会间歇 429**(`upstream_rate_limit`),所以按 `--steps=` 分片跑并在片间留出间隔;429 重跑即绿,不修改/放宽断言。
- `smoke:efforts` 26 passed / 4 failed:四例 FAIL 全属 `step-5-preview-free`,上游直接 400 `Upstream request failed: Model is unavailable.`(两种格式都是,见 `scripts/probe-deepseek-routing.ts step-5-preview-free` 的裸探针)——即该限时预览模型在 zen 边缘已下线,与本次改动无关,断言保持原样以如实暴露上游状态。mimo / space-bunny / deepseek / glm / muse 的档位与元数据断言全绿(glm 七档 + `none`→`low` 全过)。


三线同步同 7.4:egress / supabase / main 的 `_lib/types.ts` + `models.ts` + 测试 + 脚本 + README 一起落地。

## 8. 2026-10-17 退役事件:muse 弃用 + oa-compat 挂载迁移 + stream:false 门禁

这一轮**门槛没有变**(2.0.28→2.0.32 的 UA 都能过,工具/头/ID 指纹全部未动),但上游把 muse 本身退役了,连锁三件事:

### 8.1 症状与定位

- 全模型报 502 `upstream_error`,流式细节是 `{"error":"...Model muse-spark-1.3-contributor-free has been deprecated."}`、`Model does not support this protocol` 甚至整个 404 HTML——muse 之外的模型混报,是"个别模型退役 + 端点搬家"的典型组合,先怀疑目录而不是指纹。
- `bun run scripts/probe-muse-deprecation.ts`(本轮新增):对 6 个免费模型逐个打三个端点——
  `/inference/v1/chat/completions`、`/inference/openai/v1/chat/completions`(本轮 catalog provider.api 新挂载,.ipv6 副本同)、`/inference/v1/responses`。流式发、真 UA、`prompt_cache_key: ses_<32hex>`。
- 探针结论:
  - **muse**:两个 chat 挂载 401/429/403 + `Model muse-spark-1.3-contributor-free has been deprecated.`;`/v1/responses` 直接 404——muse 彻底退役。
  - **其余 oa-compat 免费模型**:旧挂载 `/inference/v1/chat/completions` 仍 200,新挂载 `/inference/openai/v1/chat/completions` 同样 200;`/v1/responses` 对全部模型 400 `ModelProtocolUnsupported` 或不路由。catalog 的 Responses 端点全部改指 `/inference/openai/v1`。
  - **step-5**:两个挂载一致 `Upstream request failed: Model is unavailable.`——限时预览到期下线(2026-10-16 已见端倪,本轮彻底)。
- **门禁复核**(第 6 轮结论仍然成立):同一指纹下 `stream:false` 必挂 403 `{"type":"error","error":{"type":"inference error",...,"provider_id":"public"}}`,`stream:true` 200——免费层依旧"只伺候流式"。

### 8.2 修复(已实施):muse/goal/未知 id 别名到 deepseek

- **`_lib/types.ts`**:`MUSE_INFO`/`GOAL_INFO` 补 `upstreamId: MODEL_DEEPSEEK`,`MODEL_WIRE`/`lowerChatUpstream` 统一"发上游用 `upstreamId ?? id`、回下游仍用客户端 id";muse 两条信息(原 Responses 直发说明)改为弃用别名说明;`MUSE_INFO.reasoning_levels` 直接继承 deepseek 的 `["low","high","max"]`,`clampEffortForModel` 对 muse/goal 按 deepseek 档位钳制并同样补 `max_tokens`。原 muse 档位与加密思考回放(`encrypted_content`/`reasoning_details`)随上游退役一起作废。
- **`_lib/chat-upstream.ts` + `_lib/oa-compat.ts`**:`OaCompatRaiser` 成为唯一升格路径(原 muse Responses 分支删除);goal 的 `GoalCtx` 挂到同一个 `postChatUpstream`/`streamEvents`,judge 改为 `lowerChatUpstream(...)+postChatUpstream` 的流式聚合调用(免费层要求 `stream:true`),judge body 与正轮共用 `OACompatFingerprint`(逐字 client tools、`prompt_cache_key: ses_<sessionId>`、`X-Opencode-Client: cli`)。
- **`_lib/goal.ts`**:继续只对 goal id 启用;judge prompt(`JUDGE_PROMPT`)、`sawToolCalls`/`maxRounds`/maxRounds=0 等行为不变,判未完成自动续轮,续轮与 judge 记录照打 `[goal]` 日志。实测:`judge -> complete`、`judge -> continue`、`turn 1/N: continuing` 三条真实上游路径全通。
- **`_lib/lower.ts`** 分流删除,`lowerChatUpstream` 成为唯一降级出口。
- 模型 id 处理三原则:客户端 id 只用于回显与审计,上游 wire 一律用存活模型 id;未知/未匹配 id 先落 muse 再经别名落 deepseek;goal 的 judge/正轮同 mount 同指纹,只差 body。

### 8.3 验证(全部真实上游)

```bash
bun run test                            # 217/217(goal/goal-wiring/alias-downlink/chat-truncate/chat-upstream 全部改写钉死新语义)
bun run typecheck                       # tsc --noEmit 通过;deno check / deno bundle 同过
bun run scripts/probe-muse-deprecation.ts   # 全部 7 模型 × 3 端点矩阵

```


- muse id 三门面真实上游跑齐(chat/responses/messages),goal id 真实上游跑齐 judge/续轮全路径。
- 三线同步同 7.4:egress / supabase / main 的 `_lib` 与测试一起落地(见 §7.4)。

### 8.4 排查思路复盘(下次遇到"突然全挂"先看这里)

1. **先分模型广泛探**:不要只盯 muse——一个模型 404 而其他 200 说明是目录/路由问题,不是门槛问题。
2. **gate 复核先行**:拿到 403 FreeTierError 先跑 stream:true/false 对照(6 轮结论),不对就先查指纹,对就查模型目录。
3. **多个端点都试**:同一模型把 `/inference/v1/chat/completions`、`/inference/openai/v1/chat/completions`、`/inference/v1/responses` 都打一遍;上游会搬家,旧挂载可能与新挂载并行存在,catalog 的 `provider.api` 是最权威的落点。
4. **弃用模型不要试图救活**:Zen 上线即弃用的模型不给宽限期;正确动作是别名(保客户端 id 语义)而非硬编码新 id。
5. 换挂载后 UA/头/工具逐字复检——本轮新挂载对 2.0.28-2.0.32 的旧 UA 一律放行,但**下次未必**。

### 8.5 2026-10-19 复核:免费集再洗牌 + 六个存活模型入目录 + 退役 id 下架

这一轮同样**不是门禁问题**——完整指纹照旧,变动全在免费集与目录本身。

- **排查路径**:先跑 `bun run scripts/probe-free-sweep.ts`(读 `models.opencode.ai/api.json` 的 `opencode.models`,对每个 `free|pickle` id 同时打 chat / responses 两个挂载,用真实指纹发过闸门 body)。本轮从沙箱网络探测时免费层按 IP 拒绝(403 `FreeTierError`:**“OpenCode's free models aren't available from your current network because we've detected abusive traffic from this network”**——这是 **IP 级封锁**,与指纹/模型无关;mimo/deepseek/glm 等存量模型同样被拒。遇到这个文案不要改指纹,换出口(egress 分支的本机副出口轮询即为此而生)或等待解封;catalog 读取与 `status` 字段不受影响)。`status=deprecated` 的 muse 1.2/1.3 直接 410 `ModelDeprecated`,step-5 仍是 400 `Model is unavailable.`。
- **结论(以 catalog `status` + 上一轮真实探测为准)**:mimo / space-bunny / deepseek / glm / longcat / beam / nemotron-lightning / nemotron-ultra / nemotron-super-vl 九条 chat 存活,加上不带后缀的 `big-pickle`(成本 0/0/0)共 **10 个存活免费档**;`cat-jam-free` / `exo-free` 等 `deprecated` id 不纳入(见「模型目录」)。
- **修复(已实施)**:
  1. `api/_lib/types.ts` 新增六个条目(`BIG_PICKLE_INFO` / `LONGCAT_INFO` / `BEAM_INFO` / `NEMOTRON_LIGHTNING_INFO` / `NEMOTRON_ULTRA_INFO` / `NEMOTRON_SUPER_VL_INFO`),`MODELS` 追加、`resolveModel` 加 `longcat*` / `big-pickle` / `beam*` / `nemotron*`(按 `ultra` / `super-vl` 分流)前缀。
  2. `STEP5_INFO` 改退休别名(照 muse 处理):保留 id + `upstreamId: MODEL_DEEPSEEK`,档位继承 deepseek(`low/high/max`,`none` → `low`);`MUSE_INFO` / `STEP5_INFO` 加 `listed: false`,`api/models.ts` 过滤不上架——`/v1/models` 不再广告必挂的条目,历史 id 仍解析。
  3. `api/models.ts` 的 `REASONING_MODELS` 补六个新 id;测试/冒烟全部同步(`chat-upstream.test.ts`、`smoke-newmodels`、`smoke-efforts` 的目录断言;本分支没有 `router.test.ts` / `smoke-step5` / `smoke-edge`)。
- **验证**:`bun run test` 195/195、`bun run typecheck` 全过(全部 mock 上游,无需联网;本分支无 `typecheck:edge`)。**真上游冒烟本沙箱网络被免费层 IP 封锁无法执行**(见上),需要在本机 egress 部署上按 §7.3 口径补跑:`bun run smoke:newmodels <新模型> --steps=chat,chat-stream`(矩阵大,分片跑)、`bun run smoke:efforts`。
- **未做**:muse 门的 Responses 直发路径保持删除状态(`chat-upstream.ts` 唯一出口不变);`deprecated` 但暂未硬退的 id 不入目录。

## 9. 下次上游再更新时的排查清单(Cheat Sheet)

按序检查,命中即修:

1. **报错是否变了文案/状态码?** 收集当前 4xx 响应体,和 `api/_lib/errors.ts` 的映射对照。429→403 或新增 `FreeTierError` 字样 = 门槛升级信号。
2. **重抓基准(唯一权威)。** 用**当前版本真实 CLI** 抓一份完整请求(头+体)并精确重放确认 200。v1 客户端可用 `scripts/capture-server.ts`;v2 客户端的 provider 基址来自 models.dev/远程配置,配置覆盖不生效,**必须本地 MITM**(见第 5.5 节)。
3. **版本号过期?** 先确认跟的是哪条线:`@opencode/cli`(v2,仓库 `anomalyco/opencode`,线上 UA `opencode/latest/<version>/cli`)还是 `opencode-ai`(v1)。`npm view @opencode/cli version`,更新 `api/_lib/types.ts` 的 `OPENCODE_VERSION` / `OPENCODE_CHANNEL`。上游大版本发布后这几乎总是第一步。
4. **头指纹变了?** 对比抓包头与 `api/chat.ts` 发的头集合(新增头?删除头?UA 格式?)。注意:**仓库源码的 UA 构造可能与线上二进制不一致**,以抓包为准。
5. **ID 形状变了?** 两步走:(a) 对照 `packages/schema/src/identifier.ts` 的 `Identifier.create`(前缀、26 字符、**descending 取反**)更新 `api/_lib/identity.ts`;(b) **逐位扫描**——固定前缀只扫低 12 位(或 counter),找出上游接受的区间。2026-10-13 的门槛就是"低 12 位 ≥ 0xFC0":形状正确但 ascending 一样被拒,别只测长度和前缀。
6. **请求体指纹变了?(2026-09-18 / 2026-10-14 新增此类)** 用抓包体做消融:删 tools / 换 tools / 加 `reasoning` / 改 `prompt_cache_key` / 首条 role 换 `system`,一次只改一项,找到被校验的新字段。内置工具清单与**逐字定义**存于 `api/_lib/tools.ts`,若 CLI 工具集变化则重抓刷新该数组;注意门槛现在会逐字比对描述与参数,且退役名(`bash`/`task`/`todowrite`)与同名遮蔽都会 403——客户端同名工具走 `mp_` 别名。
7. **上游 API 支持面变了?** 例如 `tool_choice` 现在只支持 `"auto"`;留意 400 响应里的 `param` 字段直接指出被拒参数。
8. **报错文案 grep 不到?** 校验在闭源边缘服务里,别浪费时间翻 CLI 逻辑,专注完整模仿客户端指纹(头 + 体)。
9. **免费模型 ID 变了?** 先跑 `bun run scripts/probe-free-sweep.ts` 看 catalog `status` 与存活面;退役 id 走别名 + `listed: false`(见 §8.5),不要报 404。
10. **新模型要加?** `models.opencode.ai/api.json` 拿条目 → `scripts/probe-free-sweep.ts`(全量存活扫)或 `scripts/probe-deepseek-routing.ts <id>` 探格式(oa-compat 还是 responses)→ `MODELS` / `resolveModel` / `REASONING_MODELS` → `bun run smoke:newmodels <模型> --steps=...` 全项 → `bun run smoke:efforts`。详细步骤见第 7.2 节。
11. 修复后按顺序跑 `bun run test` → `bun run smoke` → `bun run eval`,全绿再收工;模型矩阵类套件用 `smoke:newmodels` 的 `--steps=` 分片跑,别在一个命令里打几十次真实上游。

## 10. 行为与合规注意事项

- 指纹模仿的是**无凭据的免费匿名层**,按 IP 限额;请勿用于绕过付费或大规模滥用,上游随时可能再次收紧。
- 内置工具按门槛要求**逐字下发**(描述/参数与真实客户端一致)——这是 2026-10-14 起过门槛的必要条件。
  为保证模型优先使用客户端自己的工具,同名客户端工具以 `mp_<name>` 别名下发、下行再还原;
  客户端未声明的内置调用在上下行两侧都被隐藏,模型不会拿到客户端无法执行的调用结果。
- 代理无状态,不落盘任何会话数据;加密思考 blob(`encrypted_content`)永不回传(会话绑定),只回放可见推理文本;deepseek thinking mode 下缺失时以空串占位,否则上游 400。
- `MODEL_ID` 把所有请求映射到免费模型;如需接入其他模型,改 `api/_lib/types.ts` 的 `MODEL_ID` 并确认上游允许。
