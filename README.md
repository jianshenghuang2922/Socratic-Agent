# Socratic Agent

基于 URL 内容的智能问答 Agent。给它一个**网页**或**代码仓库**地址，它会读取内容、建立可检索的索引，然后你可以直接提问，也可以让它针对这份内容出题考你。

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

## 用自己的 API Key（BYOK）

线上部署默认**不带**共享的模型密钥 —— 一个公开地址挂一个付费 Key，几分钟就会被刷爆。
所以应用支持让每个用户填自己的 Key：

1. 打开页面右上角的 **模型设置**（徽标会显示当前用的是哪份凭据）；
2. 选一个服务商预设（OpenRouter / DeepSeek / 硅基流动 / OpenAI）或直接填任意 OpenAI 兼容网关；
3. 填入 API Key，保存。

Key 只存在**你自己的浏览器**（localStorage），随每次请求通过 `x-llm-api-key` / `x-llm-base-url` /
`x-llm-model` 请求头发给服务端，服务端只在这一次请求里用它调模型，不落库、不写日志。

几个行为约定：

- **填了自带 Key 就优先用它**，服务端的凭据被忽略，且不再走跨网关的备用模型链（那串备用模型是给服务端网关准备的）。
- 服务端没配凭据、用户也没填时，接口返回的是「请点击右上角模型设置」这类可操作提示，而不是一句裸的 500。
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
| `ALLOW_PRIVATE_LLM_BASE_URL` | 设为 `1` 允许用户把自定义网关指向内网/本机（本地开发连 Ollama 时用） |
| `RAG_EXPAND_QUERY` | 设为 `0` 关闭 LLM 查询扩展（省额度） |
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
| `GET /config` | — | `{ llmConfigured, model, byok }`，前端据此决定要不要引导用户填自己的 Key |
| `POST /context` | `{ url }` | `{ contextId, url, kind, title, summary, size, chunks }` |
| `POST /ask` | `{ contextId, question, history }` | `{ answer, sources, expanded }` |
| `POST /ask/stream` | 同上 | SSE：`status` / `sources` / `delta` / `done` / `error` |
| `POST /question` | `{ contextId, mode, history }` | `{ id, type, prompt, options?, sources }` |
| `POST /grade` | `{ contextId, type, questionId, selectedIndex \| question, answer }` | `ChoiceGrade \| ShortGrade` |

状态码：`400` 参数错误 · `410` 会话或答案键失效 · `502` 上游失败。

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


