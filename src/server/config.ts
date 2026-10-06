/**
 * 服务端配置解析。
 * 所有密钥只从 .env 读取，代码里不出现任何字面量。
 */

function int(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 主模型失败（限流 / 5xx / 空输出）时依次降级的备用模型 */
  fallbackModels: string[];
  /** 单个模型的尝试次数（含首次） */
  maxRetries: number;
}

/**
 * 请求级的凭据覆盖 —— 「用户自带 API Key」（BYOK）的落点。
 *
 * 用户在浏览器里填自己的网关地址 / Key / 模型，前端随每次请求用请求头发过来，
 * 服务端只在这**一次请求**里用它调模型，不落盘、不进日志。
 * 没带覆盖时，行为与从前完全一致（走 .env 里的服务端凭据）。
 */
export interface LlmOverride {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** 服务端凭据缺省时的兜底网关 */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * 备用模型链的默认值。
 * 上游（尤其 OpenRouter 的免费/低价 provider）经常返回 429，
 * 换一个 provider 就能通 —— 单次 429 不该让整道题失败。
 * 用 LLM_FALLBACK_MODELS 覆盖（逗号分隔，留空则关闭降级）。
 */
const DEFAULT_FALLBACK_MODELS = 'deepseek/deepseek-chat-v3.1,qwen/qwen3-max,z-ai/glm-4.6';

function parseList(value: string | undefined, fallback: string): string[] {
  const raw = value === undefined ? fallback : value;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function llmConfig(override?: LlmOverride): LlmConfig {
  const envModel = process.env.LLM_MODEL?.trim() || 'gpt-4o-mini';
  const maxRetries = int('LLM_MAX_RETRIES', 3);

  /*
   * 用户自带 Key：只认他给的网关与模型。
   *
   * 关键取舍 —— 此时**不做跨网关降级**。
   * 备用模型链是给服务端自己那套网关准备的；套到用户的 Key 上，只会把请求打到
   * 对方根本不认识的模型上，白白拖长等待，最后仍然失败。宁可快速报错。
   */
  if (override?.apiKey) {
    return {
      apiKey: override.apiKey,
      baseUrl: (override.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
      model: override.model?.trim() || envModel,
      fallbackModels: [],
      maxRetries,
    };
  }

  // OPENAI_* 优先（OpenAI 兼容网关），回落到 CodeBuddy Agent SDK 的凭据
  const apiKey =
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.CODEBUDDY_API_KEY?.trim() ||
    process.env.CODEBUDDY_AUTH_TOKEN?.trim() ||
    '';

  const baseUrl = (
    process.env.OPENAI_BASE_URL?.trim() ||
    process.env.CODEBUDDY_BASE_URL?.trim() ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '');

  const fallbackModels = parseList(process.env.LLM_FALLBACK_MODELS, DEFAULT_FALLBACK_MODELS).filter(
    (m) => m !== envModel,
  );

  return { apiKey, baseUrl, model: envModel, fallbackModels, maxRetries };
}

/** 服务端自己是否配了模型凭据（用于前端判断要不要引导用户自带 Key） */
export function hasServerCredentials(): boolean {
  return Boolean(llmConfig().apiKey);
}

export const limits = {
  /** 单个文件超过这个大小就跳过 */
  maxFileSizeBytes: int('MAX_FILE_SIZE_MB', 5) * 1024 * 1024,
  /** 仓库最多遍历多少个文件 */
  maxFiles: int('MAX_FILES', 50000),
  /** 单次分析（克隆 + 遍历）的总超时 */
  analysisTimeoutMs: int('ANALYSIS_TIMEOUT_SECONDS', 900) * 1000,
  /**
   * git clone 的超时。
   * 原本由 .env 的 CLONE_TIMEOUT_SECONDS 控制，按用户要求已从 .env.example 移除，
   * 因此改为代码内常量。
   */
  cloneTimeoutMs: 180_000,
  /**
   * 克隆期间「还在动」心跳的间隔。
   * `git clone` 期间拿不到任何进度，而超时上限有 180s —— 不报点东西，
   * 用户无法判断是卡死了还是在下载。正常无需改；调小只是为了能在回归里
   * 验证心跳真的会发（不然得等一次 8s 以上的克隆）。
   */
  cloneHeartbeatMs: int('CLONE_HEARTBEAT_SECONDS', 8) * 1000,
  /** 抓取网页的超时 */
  fetchTimeoutMs: 20_000,
  /**
   * 抓取网页时最多读取多少字节。
   * 用户给的 URL 由服务端代抓，不设上限的话一个超大响应就能把进程内存打满
   * （公开部署普遍只有 512MB）。超限即截断，后面的正文抽取照常进行。
   */
  maxHtmlBytes: int('MAX_HTML_MB', 8) * 1024 * 1024,
  /**
   * 建索引时最多读入多少字符。
   * 有了检索就不必再把整个项目塞进 prompt —— 全量索引、按需召回。
   * 这个上限只是兜住内存，正常仓库远够用。
   */
  indexBudgetChars: int('INDEX_BUDGET_CHARS', 600_000),
  /** 单个文件送入索引的上限（超长文件按声明边界切块，不会整体丢弃） */
  maxCharsPerFile: int('MAX_CHARS_PER_FILE_CHARS', 20_000),
  /** 出题时召回的资料预算（字符） */
  contextBudgetChars: int('CONTEXT_BUDGET_CHARS', 16_000),
  /** 回答问题时召回的资料预算（字符），比出题小 */
  answerBudgetChars: int('ANSWER_BUDGET_CHARS', 6_000),
  /** 单次检索最多返回多少块 */
  maxChunks: int('MAX_CHUNKS', 12),
  /**
   * 单次模型调用的输出 token 预算。
   *
   * ⚠️ 这里必须给推理模型留够 —— **推理过程同样计入这个预算**。
   * 实测同一个出题提示词：非推理模型正文只要几百 token，
   * 而推理模型光推理就烧掉 1300 ~ 4000 token。预算给 2500 时会出现
   * 「推理还没结束预算就没了」：正文要么为空，要么 JSON 被切成半截
   * （缺右括号 → `extractJson` 解析失败 → 前端看到
   * 「模型没有返回合法的 JSON（选择题），请重试」）。实测 8000 可覆盖。
   *
   * 注意：部分网关（如 OpenRouter）按 max_tokens **预扣**额度，
   * 余额很小的付费账号会被 402 拒绝 —— 那种情况下把这个值调小，
   * 或改用 `:free` 模型（免费模型不涉及余额预扣）。
   */
  llmMaxTokens: int('LLM_MAX_TOKENS', 8000),
  /**
   * 输出被截断（`finish_reason: length`）时，逐次把预算翻倍的上限。
   * 有它兜底，即使 `LLM_MAX_TOKENS` 配小了也能自己爬上来；
   * 设上限是为了防止一个坏配置把 token 烧到天上。
   */
  llmMaxTokensCeiling: int('LLM_MAX_TOKENS_CEILING', 16000),
  /**
   * 是否启用 LLM 查询扩展。
   * 中文提问与英文代码之间没有字面重叠，靠它才能召回（实测 Top-1 从 1/10 提到 6/10）。
   * 代价是每次中文检索多一次 LLM 调用 —— 额度紧张时可以设 RAG_EXPAND_QUERY=0 关掉。
   */
  ragExpandQuery: process.env.RAG_EXPAND_QUERY !== '0',
};

/**
 * 稠密向量检索的可选配置。
 * 当前环境（OpenRouter 403 / CodeBuddy 404）拿不到 embeddings 接口，
 * 因此默认关闭，纯走 BM25；填了这三项就自动启用并与 BM25 做 RRF 融合。
 */
export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function embeddingConfig(): EmbeddingConfig | null {
  const baseUrl = (
    process.env.EMBEDDING_BASE_URL?.trim() ||
    process.env.OPENAI_EMBEDDING_BASE_URL?.trim() ||
    ''
  ).replace(/\/+$/, '');
  const apiKey =
    process.env.EMBEDDING_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || '';
  const model = process.env.EMBEDDING_MODEL?.trim() || '';

  // 三项齐备才启用 —— 少任何一项都说明用户没打算用稠密检索
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

export function assertLlmConfigured(override?: LlmOverride): void {
  const { apiKey } = llmConfig(override);
  if (!apiKey) {
    throw new Error(
      '未配置 LLM 凭据：请在 .env 中填写 OPENAI_API_KEY（OpenAI 兼容网关）或 CODEBUDDY_API_KEY',
    );
  }
}
