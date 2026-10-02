# Socratic Agent

基于 URL 内容的智能问答 Agent。给它一个**网页**或**代码仓库**地址，它会读取内容、建立可检索的索引，然后你可以直接提问，也可以让它针对这份内容出题考你。

## 功能

- **提问模式** —— 针对 URL 内容回答，答案来自检索到的原文，不靠模型的通用记忆
- **回答模式** —— 主动出题（选择题 / 简答题），题干锚定资料里真实存在的文件或函数，不是通用八股
- **RAG 检索** —— 项目内容与你的作答记录进同一个索引；答错的题会成为后续出题的薄弱点
- **判分** —— 选择题纯服务端比对（不调模型），简答题由模型批改
- **计分** —— 答对 +5 分，并累计出题数

## 技术栈

Next.js 15（App Router）+ TypeScript + React 19。无 UI 框架，样式手写在 `globals.css`。  
检索用 BM25 稀疏检索（预留稠密向量接口，配了 `EMBEDDING_*` 即启用并与 BM25 做 RRF 融合），  
生成侧接任意 OpenAI 兼容网关。**会话状态存在进程内存里，不依赖任何数据库。**

## 快速开始

```bash
npm install
cp .env.example .env     # 填好 OPENAI_API_KEY / OPENAI_BASE_URL / LLM_MODEL
npm run dev              # http://localhost:3000
```

## 环境变量

| 变量                       | 说明                          |
| ------------------------ | --------------------------- |
| `OPENAI_API_KEY`         | 网关密钥                        |
| `OPENAI_BASE_URL`        | OpenAI 兼容网关地址               |
| `LLM_MODEL`              | 主模型                         |
| `LLM_FALLBACK_MODELS`    | 备用模型链，主模型被限流/故障时依次降级        |
| `LLM_MAX_RETRIES`        | 单个模型的尝试次数，默认 3              |
| `NEXT_PUBLIC_AGENT_MODE` | `http` 走真实后端，`mock` 用内置模拟数据 |
| `RAG_EXPAND_QUERY`       | 设为 `0` 关闭 LLM 查询扩展（省额度）     |
| `INDEX_BUDGET_CHARS`     | 建索引时读入的字符上限                 |

检索预算、embedding 等完整配置见 `.env.example`。

## API

服务端位于 `src/app/api/agent/`：

| 端点               | 请求体                                                                  | 响应                                                       |
| ---------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| `POST /context`  | `{ url }`                                                            | `{ contextId, url, kind, title, summary, size, chunks }` |
| `POST /ask`      | `{ contextId, question, history }`                                   | `{ answer, sources, expanded }`                          |
| `POST /question` | `{ contextId, mode, history }`                                       | `{ id, type, prompt, options?, sources }`                |
| `POST /grade`    | `{ contextId, type, questionId, selectedIndex \| question, answer }` | `ChoiceGrade \| ShortGrade`                              |

状态码：`400` 参数错误 · `410` 会话或答案键失效 · `502` 上游失败。

**正确答案只保存在服务端**（`src/server/store.ts`），从不下发前端。

## 目录结构

```
src/
├── app/          页面与 API 路由
├── components/   UI 组件
├── hooks/        会话状态（useQASession）
├── lib/          类型契约与 AgentClient 实现
└── server/       检索、提示词、会话存储、内容解析
```

## 开发说明

- 前端只依赖 `AgentClient` 接口（`src/lib/types.ts`），页面组件不直接 fetch 后端
- 调整行为优先改提示词 `src/server/prompts.ts`，不要改路由
- `npm run typecheck` 做类型检查；`/api/agent/inspect` 是仅开发环境可用的检索调试端点
