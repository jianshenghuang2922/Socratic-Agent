import { llmConfig, limits, type LlmOverride } from './config';
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
  /** 用户自带的凭据（BYOK）。不给就用服务端 .env 里的凭据 */
  override?: LlmOverride;
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
  /** 流式专用：是否已经往客户端吐过字。吐过就不能重试/换模型，否则内容会重复 */
  emitted?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 一条凭据都没有时的提示。
 * 公网部署上这是最常见的失败，所以文案必须能直接指路，而不是只说「没配 Key」。
 */
function missingCredentialError(): ApiError {
  return new ApiError(
    500,
    '本服务未配置模型凭据。请点击页面右上角「模型设置」，填入你自己的 API Key（支持 OpenRouter、DeepSeek 等任意 OpenAI 兼容网关）后即可使用。',
  );
}

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

  // 读 body 同样可能被 AbortSignal 打断，必须一起兜住，
  // 否则超时会在这一行抛成非 ApiError，路由只能回 500「服务端异常」
  let raw: string;
  try {
    raw = await response.text();
  } catch (err) {
    return { ok: false, status: 0, retryable: true, detail: describeNetworkError(err, '调用大模型') };
  }

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
  const cfg = llmConfig(options.override);
  if (!cfg.apiKey) throw missingCredentialError();

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

/* ------------------------------------------------------------------ */
/* 流式输出                                                            */
/* ------------------------------------------------------------------ */

interface StreamAttemptResult extends AttemptResult {
  /** 已吐给客户端的正文累计值 */
  content: string;
}

/**
 * 单次流式调用。不抛异常，把结果压成 StreamAttemptResult。
 *
 * 关键约束：一旦通过 onDelta 吐过字，就不能再重试或换模型 ——
 * 用户已经看到前半段，重来一遍会把内容接成「前半段 + 完整版」。
 * 所以 `emitted` 会被上层用来判断「能不能重来」。
 */
async function streamOnce(
  model: string,
  messages: ChatMessage[],
  opts: {
    apiKey: string;
    baseUrl: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
  },
  onDelta: (delta: string) => void,
): Promise<StreamAttemptResult> {
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
        stream: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      retryable: true,
      detail: describeNetworkError(err, '调用大模型'),
      content: '',
      emitted: false,
    };
  }

  if (!response.ok) {
    let raw = '';
    try {
      raw = await response.text();
    } catch {
      /* 错误响应体读不出来就算了，用状态码兜底 */
    }
    let detail = raw.slice(0, 400);
    try {
      const parsed = JSON.parse(raw) as ChatCompletionResponse;
      detail = parsed.error?.message ?? detail;
    } catch {
      /* 上游不一定返回 JSON */
    }
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, status: response.status, retryable, detail, content: '', emitted: false };
  }

  if (!response.body) {
    return {
      ok: false,
      status: response.status,
      retryable: true,
      detail: '网关没有返回流式响应体',
      content: '',
      emitted: false,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let emitted = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE：一行一个字段，事件之间以空行分隔。逐行取 `data:` 载荷。
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let chunk: ChatCompletionResponse & {
          choices?: Array<{ delta?: { content?: string | null } }>;
        };
        try {
          chunk = JSON.parse(payload) as typeof chunk;
        } catch {
          continue; // 半行 JSON，等下一片
        }

        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          content += delta;
          emitted = true;
          onDelta(delta);
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      retryable: !emitted,
      detail: describeNetworkError(err, '读取模型输出流'),
      content,
      emitted,
    };
  }

  if (content.trim()) {
    return { ok: true, status: 200, retryable: false, detail: '', content: content.trim(), emitted: true };
  }
  return { ok: false, status: 200, retryable: true, detail: '模型流式返回了空内容', content: '', emitted };
}

/**
 * 流式调用，逐段把正文交给 `onDelta`，返回完整正文。
 *
 * 健壮性策略与非流式一致（单模型内重试 + 备用模型链降级），
 * 但多一条硬约束：**已经开始吐字就不许重来**。
 * 上游在流中途断掉时，与其把重复内容接在用户眼前，不如直接报错让用户重试。
 */
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  options: ChatOptions = {},
): Promise<string> {
  const cfg = llmConfig(options.override);
  if (!cfg.apiKey) throw missingCredentialError();

  const { temperature = 0.3, maxTokens = 3000, timeoutMs = 90_000 } = options;
  const models = [cfg.model, ...cfg.fallbackModels];
  const failures: string[] = [];

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    let last: StreamAttemptResult = {
      ok: false,
      status: 0,
      retryable: false,
      detail: '未执行',
      content: '',
      emitted: false,
    };

    for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
      const result = await streamOnce(
        model,
        messages,
        { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, temperature, maxTokens, timeoutMs },
        onDelta,
      );

      if (result.ok && result.content) {
        if (mi > 0) console.warn(`[llm] 已降级到备用模型 ${model} 并成功（流式）`);
        return result.content;
      }

      last = result;

      // 已经吐过字：重试或换模型都会造成内容重复，只能认输
      if (result.emitted) {
        throw new ApiError(502, `模型输出中断（${result.detail}），请重试`);
      }

      if (!result.retryable) break;

      if (attempt < cfg.maxRetries) {
        const wait = Math.min(8000, 600 * 2 ** (attempt - 1)) + Math.round(Math.random() * 300);
        console.warn(
          `[llm] ${model} 流式第 ${attempt} 次失败（${result.status || '网络'}）：${result.detail}；${wait}ms 后重试`,
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
