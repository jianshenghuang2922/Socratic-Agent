import { llmConfig, limits } from './config';
import { ApiError, describeNetworkError } from './http';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  /**
   * 默认给得比较宽裕。
   * 注意：如果配置的是推理模型（如 dots / o1 / deepseek-r1），
   * 推理 token 同样计入 max_tokens，预算给小了 content 会直接是 null。
   */
  maxTokens?: number;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      /** 部分推理模型把思维链放在这里 */
      reasoning?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  error?: { message?: string };
}

interface AttemptResult {
  ok: boolean;
  /** HTTP 状态码；网络层异常记为 0 */
  status: number;
  /** 是否值得重试（限流 / 5xx / 网络抖动 / 空输出）；4xx 业务错误不重试，直接换模型 */
  retryable: boolean;
  detail: string;
  content?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 单次调用。不抛异常，把结果压成 AttemptResult，由上层决定重试还是换模型。 */
async function attemptOnce(
  model: string,
  messages: ChatMessage[],
  opts: {
    apiKey: string;
    baseUrl: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
  },
): Promise<AttemptResult> {
  const { apiKey, baseUrl, temperature, maxTokens, timeoutMs } = opts;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, status: 0, retryable: true, detail: describeNetworkError(err, '调用大模型') };
  }

  const raw = await response.text();

  if (!response.ok) {
    let detail = raw.slice(0, 400);
    try {
      const parsed = JSON.parse(raw) as ChatCompletionResponse;
      detail = parsed.error?.message ?? detail;
    } catch {
      /* 上游不一定返回 JSON，保留原文片段 */
    }
    // 429 限流、5xx 上游故障 —— 重试或换 provider 都可能成功
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, status: response.status, retryable, detail };
  }

  let data: ChatCompletionResponse;
  try {
    data = JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    return { ok: false, status: response.status, retryable: true, detail: '网关返回了非 JSON 响应' };
  }

  const choice = data.choices?.[0];
  const content = choice?.message?.content;

  if (typeof content === 'string' && content.trim()) {
    return { ok: true, status: response.status, retryable: false, detail: '', content: content.trim() };
  }

  // 走到这里说明 content 为空 —— 推理模型最常见的两种失败形态
  const hasReasoning = Boolean(
    choice?.message?.reasoning?.trim() || choice?.message?.reasoning_content?.trim(),
  );

  const detail =
    choice?.finish_reason === 'length'
      ? hasReasoning
        ? `输出被 max_tokens 截断（当前 ${maxTokens}）。该模型是推理模型，推理过程会消耗大量 token，请调大预算或改用非推理模型。`
        : `输出被 max_tokens 截断（当前 ${maxTokens}），请调大预算。`
      : hasReasoning
        ? '只输出了推理过程、没有给出正文'
        : '返回了空内容';

  return { ok: false, status: response.status, retryable: true, detail };
}

/**
 * 调用 OpenAI 兼容的 /chat/completions。
 * 只依赖 fetch，不引入任何 SDK —— 网关可换、模型可换。
 *
 * 健壮性：单模型内指数退避重试，失败后沿备用模型链降级。
 * 上游 provider 的 429 是常态，不做这层的话一次抖动就会让整道题 502。
 */
export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  const cfg = llmConfig();
  if (!cfg.apiKey) {
    throw new ApiError(
      500,
      '未配置 LLM 凭据：请在 .env 中填写 OPENAI_API_KEY 或 CODEBUDDY_API_KEY',
    );
  }

  const { temperature = 0.3, maxTokens = 3000, timeoutMs = 90_000 } = options;
  const models = [cfg.model, ...cfg.fallbackModels];
  const failures: string[] = [];

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    let last: AttemptResult = { ok: false, status: 0, retryable: false, detail: '未执行' };

    for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
      const result = await attemptOnce(model, messages, {
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        temperature,
        maxTokens,
        timeoutMs,
      });

      if (result.ok && result.content) {
        if (mi > 0) console.warn(`[llm] 已降级到备用模型 ${model} 并成功`);
        return result.content;
      }

      last = result;
      if (!result.retryable) break; // 业务错误（模型名错 / 区域限制）重试无意义

      if (attempt < cfg.maxRetries) {
        const wait = Math.min(8000, 600 * 2 ** (attempt - 1)) + Math.round(Math.random() * 300);
        console.warn(
          `[llm] ${model} 第 ${attempt} 次失败（${result.status || '网络'}）：${result.detail}；${wait}ms 后重试`,
        );
        await sleep(wait);
      }
    }

    failures.push(`${model} → ${last.status || '网络'} ${last.detail}`);
    if (mi < models.length - 1) {
      console.warn(`[llm] ${model} 不可用，降级到 ${models[mi + 1]}`);
    }
  }

  throw new ApiError(502, `所有模型均调用失败：\n${failures.join('\n')}`);
}

/** 从模型输出里稳健地抠出 JSON —— 兼容代码围栏与前后废话 */
export function extractJson<T>(raw: string, what = '结构化结果'): T {
  let text = raw.trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(502, `模型没有返回合法的 JSON（${what}），请重试`);
  }
}

export { limits };
