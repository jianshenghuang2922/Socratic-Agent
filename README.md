# Socratic Agent

**丢一个链接，它出题考你有没有真读懂。**

给它一个**网页**或**代码仓库**地址，它读完内容后出题考你 —— 选择题或简答题，
题干锚定资料里真实存在的文件、函数和段落，而不是通用八股。答错的题会成为后续出题的靶子。
也可以直接对它提问，答案来自检索到的原文。

## 线上地址

**https://socratic-agent-th9l.onrender.com**

托管在 Render 免费层，连接本仓库 `master` 分支自动部署 —— 推到 GitHub 即上线（配置见 `render.yaml`）。

> 免费层限制：15 分钟无流量会休眠（冷启动约 30-60 秒）、内存 512MB、无 shell 访问。

## 功能

- **提问模式** —— 针对 URL 内容回答，答案来自检索到的原文，不靠模型的通用记忆
- **回答模式** —— 主动出题（选择题 / 简答题），题干锚定资料里真实存在的文件或函数，不是通用八股
- **RAG 检索** —— 项目内容与你的作答记录进同一个索引；答错的题会成为后续出题的薄弱点
- **判分** —— 选择题纯服务端比对（不调模型），简答题由模型批改
- **计分** —— 答对 +5 分，并累计出题数
- **自带 API Key（BYOK）** —— 公开部署不必共享一个模型 Key，每个用户填自己的即可（见下节）
- **免费试用额度** —— 没带 Key 的访客先用服务端凭据免费试几次，用完再引导他填自己的 Key（见下节）
- **分享测验** —— 把这次会话里已出的选择题打包成一条链接，别人打开就能做同一套题（见下节）

## 分享测验：零边际成本的扩散回路

做完题原本是个死胡同 —— 用户唯一的「下一步」是关掉页面。所以这里加了一条出口：
把当前会话里已出的选择题打包成一条 `/quiz/<id>` 链接，发到群里谁都能打开做。

**这条回路的边际成本是零**，这是它敢开放给陌生人的唯一原因：

- 题目和答案键在出题时就已经存在服务端了，生成链接只是换个容器装起来，一次模型都不调；
- 判分是拿 `selectedIndex` 和答案键做整数比较，零延迟、零 LLM 调用；
- 所以「生成链接」和「别人做一百遍」都**不占免费额度**，也不碰服务端账号的上游配额。

三条由此推出的设计约束：

1. **只共享选择题。** 简答题要靠模型批改，每做一次就是一次真实的上游调用 ——
   拿它做分享等于把服务端账号的配额直接开放给陌生人。
2. **答案绝不下发。** GET 只给题干与选项；每题单独 POST 判分，答案在那一刻才由服务端比对。
   和主流程「答案只存服务端」是同一口径，不要为了省一次往返把答案塞进前端。
3. **对同一会话幂等。** 重复点「分享测验」复用同一个 id、只更新内容，
   否则双击一下就得到两条链接，群里发出去的到底是哪一条说不清。

其他行为：

- 链接有效期 **7 天**（会话是 2 小时，分享链接是要隔几天被点开的，两者不能共用一个 TTL）；
- 人数按**去重后的做题者**计，不是页面打开次数 —— 预览抓取、爬虫、刷新都会产生 GET，
  按请求计只会得到一个虚高到没意义的数字；
- 做题页是**服务端渲染**的：打开就有一道题，不夹 loading；链接过期也能在首屏说清楚。

## 免费额度与自带 Key（BYOK）

公开部署的凭据策略有两条硬约束，缺一不可：

1. **不能挂一个共享的付费 Key 且不限量** —— 几分钟就会被刷爆；
2. **不能一进门就要用户填 Key** —— 等于要他拿信用卡换空气，他还没看到任何价值。

所以这里做成两段式：**先给一小份免费额度，用完再引导自带 Key**。

### 免费额度怎么算

- 计数口径是「**一次会调用模型的动作**」：解析链接 / 提问 / 出题 / 给提示 / 简答题判分。
  与内部重试次数无关 —— 一次提问内部可能重试 3 次、换 2 个模型，对用户仍然是「一次」。
- **选择题判分不占额度**：它是纯服务端比对答案键，零延迟零成本，对它收额度用户会立刻察觉不对。
- **失败会退还**：上游 429 / 超时 / 模型输出不合规，只要没产出用户可见的结果就把额度退回去。
  免费模型限流是常态，不退的话用户会被白扣到零 —— 比没有额度更糟。
- 窗口是**滚动 24 小时**（从首次使用起算），不是自然日，省掉时区与跨零点重置的歧义。
- 两层限制：`TRIAL_DAILY_LIMIT`（单个**访客**）+ `TRIAL_GLOBAL_DAILY_LIMIT`（全站合计）。
  全局那层不是冗余 —— 访客身份来自 Cookie / `x-forwarded-for`，**客户端可伪造**，
  全局上限才是不依赖任何客户端输入的硬约束。
- 身份认的是**浏览器**，不是 IP：服务端在首次访问时下发一张 Cookie（`socratic_vid`），
  额度记在这张 Cookie 上。**刷新页面不会重置额度**；没有 Cookie 的客户端（脚本 / 爬虫）
  才退回按 IP 计。

> ⚠️ 曾经这里按 IP 计数，而且取的是 `x-forwarded-for` 的**最后一段** —— 那是边缘节点的
> 地址，于是「刷新页面额度就被重置」，同时同节点的陌生人会把你的额度吃光。
> XFF 的每一跳追加的是「它看到的对端」，**最左边才是访客**。别再改回去。

> ⚠️ **默认值给得很小（单访客 10 次 / 全站 30 次），这是有意的。**
> OpenRouter 免费档是 20 请求/分钟 + **50 请求/天**（充值满 $10 才升到 1000/天）。
> 一次用户动作可能触发 2~3 次上游调用（查询改写 + 重试 + 换模型），
> 所以 50/天大约只够 **15~20 次用户动作，还是全站合计**。
> 这个额度是「让人看到第一道题」，不是「免费用一天」。
> 想真正放开，先给账号充值提额，再把 `TRIAL_GLOBAL_DAILY_LIMIT` 同步调大。

### 用自己的 API Key（BYOK）

线上部署默认**不带**共享的模型密钥 —— 一个公开地址挂一个付费 Key，几分钟就会被刷爆。
所以应用支持让每个用户填自己的 Key：

1. 打开页面右上角的 **模型设置**（徽标会显示当前用的是哪份凭据）；
2. 选一个服务商预设（OpenRouter / DeepSeek / 硅基流动 / OpenAI）或直接填任意 OpenAI 兼容网关；
3. 填入 API Key，保存。

Key 只存在**你自己的浏览器**（localStorage），随每次请求通过 `x-llm-api-key` / `x-llm-base-url` /
`x-llm-model` 请求头发给服务端，服务端只在这一次请求里用它调模型，不落库、不写日志。

几个行为约定：

- **填了自带 Key 就优先用它**，服务端的凭据被忽略，且不再走跨网关的备用模型链（那串备用模型是给服务端网关准备的）。
- **填了自带 Key 就不占免费额度**，也不受任何额度限制 —— 用的本来就是用户自己的账号配额。
- 服务端没配凭据、用户也没填时，接口返回的是「请点击右上角模型设置」这类可操作提示，而不是一句裸的 500。
- 额度用尽时接口返回 **429** 且带 `code: "trial_exhausted"`，响应体里还有最新的 `trial` 状态，
  前端据此当场把计数归零并引导去填 Key，不用再打一次 `/config`。
- 自定义网关地址**不允许指向内网 / 本机**（否则本站就成了 SSRF 跳板）。本地开发要连 Ollama 之类的内网网关，在服务端设 `ALLOW_PRIVATE_LLM_BASE_URL=1`。
- 前端默认走真实后端。只有显式设置 `NEXT_PUBLIC_AGENT_MODE=mock` 才会启用内置模拟数据 —— 用户一旦填了自带 Key，即使处于 `mock` 模式也会切到真实后端。

## 技术栈

Next.js 15（App Router）+ TypeScript + React 19。无 UI 框架，样式手写在 `globals.css`。

检索用 BM25 稀疏检索（预留稠密向量接口，配了 `EMBEDDING_*` 即启用并与 BM25 做 RRF 融合），生成侧接任意 OpenAI 兼容网关。

**会话状态存在进程内存里，不依赖任何数据库。** 这一点决定了部署方式：必须用常驻容器平台，不能上 serverless（详见文末「部署」）。

## 本地快速开始

```bash
npm install
cp .env.example .env     # 填好 OPENAI_API_KEY / OPENAI_BASE_URL / LLM_MODEL
npm run dev              # http://localhost:3000
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | 网关密钥（未设时回落到 `CODEBUDDY_API_KEY` / `CODEBUDDY_AUTH_TOKEN`）。**留空也能用** —— 用户可在页面上填自己的 Key |
| `OPENAI_BASE_URL` | OpenAI 兼容网关地址 |
| `LLM_MODEL` | 主模型 |
| `LLM_FALLBACK_MODELS` | 备用模型链，主模型被限流/故障时依次降级（用户自带 Key 时不生效） |
| `LLM_MAX_RETRIES` | 单个模型的尝试次数，默认 3 |
| `NEXT_PUBLIC_AGENT_MODE` | `http` 走真实后端，`mock` 用内置模拟数据；**不设则默认 `http`**。编译期内联，改后必须重新构建 |
| `NEXT_PUBLIC_SITE_URL` | 站点根地址，用于生成 canonical 与 OG 图片的绝对地址。不设则默认 `https://socratic-agent-th9l.onrender.com`。同样是编译期内联，换域名后必须重新构建 |
| `ALLOW_PRIVATE_LLM_BASE_URL` | 设为 `1` 允许用户把自定义网关指向内网/本机（本地开发连 Ollama 时用） |
| `RAG_EXPAND_QUERY` | 设为 `0` 关闭 LLM 查询扩展（省额度） |
| `TRIAL_ENABLED` | 设为 `0` 关闭免费额度（**不要**用把额度设成 0 的方式关，`int()` 会把非正数回落到默认值） |
| `TRIAL_DAILY_LIMIT` | 单个**访客**在 24 小时内可用几次免费额度，默认 10。访客身份是服务端下发的 Cookie（没有 Cookie 才退回 IP）。必须和账号自己的上游配额对齐，见上文 |
| `TRIAL_GLOBAL_DAILY_LIMIT` | 全站合计的 24 小时上限，默认 30。护住服务端账号的硬约束 |
| `INDEX_BUDGET_CHARS` | 建索引时读入的字符上限 |
| `ANALYSIS_TIMEOUT_SECONDS` | 仓库分析总超时，默认 900 |

检索预算、embedding 等完整配置见 `.env.example`。

> ⚠️ `NEXT_PUBLIC_*` 是**编译期内联**的：构建时环境里没有这个变量，它就不会被写进产物。
> 这曾经导致线上一直跑前端联调模拟 —— 服务端配了 Key，页面却在用假数据。
> 现在前端默认值已改为真实后端，不再依赖这个变量是否正确注入。

## API

服务端位于 `src/app/api/agent/`：

| 端点 | 请求体 | 响应 |
| --- | --- | --- |
| `GET /config` | — | `{ llmConfigured, model, byok, trial }`，前端据此决定要不要引导用户填自己的 Key |
| `POST /context` | `{ url }` | `{ contextId, url, kind, title, summary, size, chunks }` |
| `POST /ask` | `{ contextId, question, history }` | `{ answer, sources, expanded }` |
| `POST /ask/stream` | 同上 | SSE：`status` / `sources` / `delta` / `result` / `quota` / `done` / `error` |
| `POST /question` | `{ contextId, mode, history }` | `{ id, type, prompt, options?, sources }` |
| `POST /grade` | `{ contextId, type, questionId, selectedIndex \| question, answer }` | `ChoiceGrade \| ShortGrade` |
| `POST /hint` | `{ contextId, type, questionId, question? }` | `{ hint }` —— 「给点提示」：只给启发式引导，不判分、不给答案 |
| `POST /source` | `{ contextId, label }` | `SourceView` —— 引用来源详情。`label` 就是 `sources` 数组里的元素；仓库按文件聚合全部索引块并把被引用段标进 `focus`，网页只给被引用章节 |
| `POST /quiz` | `{ contextId }` | `{ quizId, title, sourceUrl, count, players }` —— 把会话里已出的选择题打包成一条分享链接。**不占免费额度**；对同一会话幂等 |
| `GET /quiz/{id}` | — | `{ id, title, sourceUrl, count, players, questions }` —— **不含答案键** |
| `POST /quiz/{id}` | `{ questionId, selectedIndex, player? }` | `{ correct, correctIndex, explanation }` —— 纯服务端比对，不调模型、不占额度、不写用户记忆 |

状态码：`400` 参数错误 · `404` 该引用来源或测验查不到 · `410` 会话或答案键失效 · `429` 免费额度用尽 · `502` 上游失败。

`/quiz` 与 `/quiz/{id}` 是**公开端点**：没有会话、不需要任何凭据，链接本身就是凭证。

`429` 的响应体是 `{ error, code: "trial_exhausted", trial: {...} }`；
`trial` 的字段是 `{ available, limit, used, remaining, resetsInMs }`。

流式端点在每个动作结束时（成功与失败都算）会发一条
`{ "type": "quota", "trial": {...} }`，前端据此刷新额度显示 ——
这样就不必在每次动作后再打一次 `/config`，那一次往返恰好发生在用户最不耐烦的时刻。

所有 `POST` 端点都接受可选的 `x-llm-api-key` / `x-llm-base-url` / `x-llm-model` 请求头（BYOK），
带了就用这份凭据调模型，没带就用服务端 `.env` 里的。

提问模式优先走 `/ask/stream`；若在**吐字之前**失败会静默退回 `/ask`，已吐字则直接报错（重放会造成内容重复）。

**采用只保存在服务端**（`src/server/store.ts`），从不下发前端。

## 目录结构

```
src/
├── app/          页面与 API 路由
├── components/   UI 组件
├── hooks/        会话状态（useQASession）
├── lib/          类型契约与 AgentClient 实现
└── server/       检索、提示词、会话存储、内容解析
scripts/
└── start.mjs     启动包装器（读 PORT、绑 0.0.0.0）
render.yaml       Render 部署配置
```

## 开发说明

- 前端只依赖 `AgentClient` 接口（`src/lib/types.ts`），页面组件不直接 fetch 后端
- 调整行为优先改提示词 `src/server/prompts.ts`，不要改路由
- `npm run typecheck` 做类型检查；`/api/agent/inspect` 是仅开发环境可用的检索调试端点
- `npm run dev` 走 Turbopack。**不要改回 webpack**：webpack 模式下 `next dev` 会同步等待 `registry.npmjs.org` 的版本检查，该请求没有超时也没有 abort 兜底，代理不通时会一直卡到 TCP 超时（约 45 秒），期间浏览器打不开页面


