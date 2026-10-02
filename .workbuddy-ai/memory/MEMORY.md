# Socratic Agent · 项目长期记忆

## 项目定位
基于 URL 内容的智能问答 Agent。**URL 既可以是网页，也可以是代码仓库**（用户 2026-10-01 明确）。
需求来源：《问答 Agent 前端需求文档 V1.0》（`C:\Users\29221\Desktop\Socraticv1.0.docx`）。

## 技术栈（由仓库既有配置推定，勿随意更换）
- **Next.js 15 App Router + TypeScript**。判定依据：`.gitignore` 含 `.next/`、`prisma/dev.db`。
- **不使用 Tailwind**，样式全部手写在 `src/app/globals.css`。
- 后端将来跑在同一个 Next 应用里（`.env` 已有 CodeBuddy Agent SDK 配置、`PORT=3000`）。
- 数据库规划为 PostgreSQL（`.env.example` 的 `DATABASE_URL`）。

## 视觉规范
- **深色玻璃拟态（glassmorphism）**，浅色方案已废弃。
- 主色：`--accent: #5b8cff`、`--accent-2: #38bdf8`（对齐背景视频的蓝调）。
- 底色 `#05070f`；玻璃面 `rgba(17,23,44,.52)`；描边 `rgba(255,255,255,.10)`。
- 背景视频：`public/bg-loop.mp4`（源素材 `D:\素材图片\待定3.mp4`，1920×1080 / 10.55s），poster 为 `public/bg-poster.jpg`。
- **背景取景的 transform 必须加在 `.bg__frame`（wrapper）上，绝不能加在 `<video>` 上**。带 transform 的 video 会被提升为独立合成层，长时间播放后画面整体偏移。video 只保留 `inset: 0` + `object-fit: cover` + `object-position`。
- 取景旋钮：`--bg-zoom`（宽屏 1.3 / 窄屏 1.16）、`--bg-lift`（6%），定义在 `.bg__frame` 上（CSS 变量继承，父层要用就得定义在父层）。验证脚本 `.tmp/verify-bg.mjs`。
- 所有玻璃面板遵循：`backdrop-filter: blur()` + 1px 半透明描边 + `inset 0 1px 0` 顶部高光 + 深色柔阴影。

## 架构约定
- **`AgentClient` 接口是前后端的唯一契约**（`src/lib/types.ts`）。
  - `MockAgentClient`（联调）与 `HttpAgentClient`（真实后端）双实现。
  - 切换开关：`.env` 的 `NEXT_PUBLIC_AGENT_MODE` = `mock` | `http`。
  - 页面组件只依赖接口，**不得直接 fetch 后端**。
- 会话状态集中在 `src/hooks/useQASession.ts`，页面组件保持无状态。

## 后端接口（已实现，`src/app/api/agent/*/route.ts`）
```
POST /api/agent/context   { url }                              -> { contextId, url, kind, title, summary, size }
POST /api/agent/ask       { contextId, question, history }     -> { answer }
POST /api/agent/question  { contextId, mode, history }         -> { id, type, prompt, options? }
POST /api/agent/grade     { contextId, type, questionId, selectedIndex | question, answer } -> ChoiceGrade | ShortGrade
```
- 状态码：**400** 参数错 / **410** 会话或答案键失效 / **502** 上游失败或模型输出不合规。
- 失败体统一 `{ error: '中文提示' }`，前端 `HttpAgentClient` 会优先展示它。
- **正确答案（`correctIndex` / `explanation` / `reference`）只存在服务端** `src/server/store.ts` 的会话表里，绝不下发前端；选择题判分是纯服务端比对（不调 LLM），简答题才调 LLM 批改。
- 服务端代码全在 `src/server/`，按 config / http / llm / store / retrieve / prompts / sources 分层。提示词集中在 `prompts.ts`，**改行为优先改提示词，别改路由**。
- `context` 返回还带 `size`（字数）与 `chunks`（语义块数），前端会展示「已建立检索索引（N 个语义块）」。

## LLM 配置（2026-10-02 实测确定）
- 网关 `https://openrouter.ai/api/v1`，**`LLM_MODEL=deepseek/deepseek-chat`**。
- **不要用 `:free` 模型**：实测 16 个全部不可用（14 个 `429 free-models-per-day`、2 个 `403 only available on agentic harnesses`）。也别选带 `-tts` / `decide` / `reasoning` 后缀的模型 —— 网关会直接 400 拒绝。
- `openai/*`、`google/*` 在本机区域受限（`403 not available in your region`）。
- **`llm.ts` 有重试 + 备用模型链**：内层指数退避重试（`LLM_MAX_RETRIES`，默认 3），外层沿 `LLM_FALLBACK_MODELS`（默认 `deepseek/deepseek-chat-v3.1,qwen/qwen3-max,z-ai/glm-4.6`）降级。上游 429 是常态，不要去掉这层。

## 前端交互约定
- **切换题型（选择题 ↔ 简答题）时，未作答的旧题会被标记 `abandoned`**（`Question.abandoned`），卡片显示「此题已作废（题型已切换）」并禁用交互，同时立即出新题。
  - 不要退回「有未作答的题就不动作」——那是静默无反应的 bug。
  - `isPendingQuestion` / `pendingQuestionId` / `MessageList.showNext` 都已排除 abandoned。

## 工作流偏好
- 改完前端要**实际截图验证**，不能只看编译通过。流程见 skill `web-ui-screenshot-verify`。
- 验证用的 `puppeteer-core` 装在 `C:/Users/29221/.workbuddy-ai/binaries/node/workspace/node_modules`（**不要装进项目依赖**；安装时务必带 `--prefix "$PWD"`，否则 npm 会向上找到用户目录的 `package.json` 装错地方）。ESM 里必须用 `createRequire('<workspace>/')` 加载，`NODE_PATH` 对 ESM 无效。
- `.tmp/` 是本地临时目录（已 gitignore）。回归脚本：`e2e.mjs`（四 API）、`e2e-rag.mjs`（RAG 六项）、`test-antirote.mjs`（反八股）、`ui-verify.mjs`（前端全链路，截图到 `.tmp/shots/`）、`verify-bg.mjs`（背景零漂移）、`mp4-info.mjs`（解析视频轨道）、`diag.mjs`（前端卡点诊断）。改完后端先跑 `e2e.mjs`。

## 环境注意（会反复踩）
- **改 `.env` 必须重启 dev server** —— `NEXT_PUBLIC_*` 编译期内联，LLM 配置也在启动时读取。
- **启动 dev server 要带 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=500000`**，否则沙箱删除守卫会在清理 `.next` 时杀死进程。
- **`npm run build` 要带 `NODE_OPTIONS="" CODEBUDDY_SAFE_DELETE_ENABLED=0`**，否则 `.next/trace` 报 EPERM。
- `next dev` 与 `next build` 不能同时跑。**本机 `github.com` / `zh.wikipedia.org` 不可达**，测试用 `gitee.com` / `cn.vuejs.org`。
- **后台 dev server 跑久了会被回收**（task 消失、端口释放）。`curl` 拿不到 200 就先重启再跑 UI 测试。
