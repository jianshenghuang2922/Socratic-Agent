import { MockAgentClient } from './mockAgent';
import { getLlmHeaders, getLlmSettings } from './llmSettings';
import type {
  AgentClient,
  AskResult,
  ChatMessage,
  ChoiceGrade,
  ChoiceQuestion,
  ShortGrade,
  ShortQuestion,
  UrlContext,
} from './types';

/** POST /api/agent/context 的响应 */
interface ContextResponse {
  contextId: string;
  url: string;
  kind: 'web' | 'repo';
  title: string;
  summary: string;
  size?: number;
  chunks?: number;
}

/** 流式失败但已经吐过字时挂上这个标记：此时不能悄悄退回一次性接口，否则内容会重复 */
interface StreamFailure extends Error {
  emitted?: boolean;
}

/** 服务端明确返回过状态码的失败（区别于网络中断 / 流被掐断） */
interface AgentHttpError extends Error {
  status?: number;
}

/**
 * HttpAgentClient —— 对接真实后端的实现。
 *
 * 后端接口（均为 POST，JSON，统一返回 { error } 作为失败体）：
 *   POST /api/agent/context      { url }                              -> { contextId, url, kind, title, summary }
 *   POST /api/agent/ask          { contextId, question, history }     -> { answer, sources, expanded }
 *   POST /api/agent/ask/stream   { contextId, question, history }     -> SSE（sources / delta / done / error）
 *   POST /api/agent/question     { contextId, mode, history }         -> ChoiceQuestion | ShortQuestion
 *   POST /api/agent/grade        { contextId, type, questionId, ... } -> ChoiceGrade | ShortGrade
 *
 * 关键设计：contextId 由 initContext 拿到后**存在客户端实例内部**，
 * 后续每次请求自动带上。这样 AgentClient 接口不用为「会话 id」开洞，
 * 页面层完全无感知。正确答案始终留在服务端，前端只能拿到题干。
 */
export class HttpAgentClient implements AgentClient {
  private contextId: string | null = null;

  constructor(private readonly baseUrl = '') {}

  /**
   * 请求头：固定带 JSON，另外把用户自带的模型凭据（BYOK）一并带上。
   * 每次请求现取 —— 用户刚在「模型设置」里改完，下一次提问就生效。
   */
  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...getLlmHeaders() };
  }

  /** 把非 2xx 响应收敛成带中文提示的 Error（并处理 410 失效） */
  private async toError(res: Response): Promise<Error> {
    // 后端统一返回 { error: '中文提示' }，优先展示它，别把原始 JSON 甩给用户
    let message = `${res.status} ${res.statusText}`;
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload?.error) message = payload.error;
    } catch {
      /* 非 JSON 响应，保留状态码描述 */
    }
    // 会话/题目已失效：清掉本地 contextId，避免后续请求继续撞同一个 410
    if (res.status === 410) this.contextId = null;
    const err = new Error(message) as AgentHttpError;
    // 带上状态码：调用方据此判断「换接口重发有没有意义」
    err.status = res.status;
    return err;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) throw await this.toError(res);

    return (await res.json()) as T;
  }

  /** 取会话 id，没有就说明流程被绕过了 */
  private session(): string {
    if (!this.contextId) {
      throw new Error('会话尚未建立，请先输入 URL 解析内容');
    }
    return this.contextId;
  }

  async initContext(url: string): Promise<UrlContext> {
    const r = await this.post<ContextResponse>('/api/agent/context', { url });
    this.contextId = r.contextId;
    return { url: r.url, title: r.title, summary: r.summary, size: r.size, chunks: r.chunks };
  }

  async ask(
    question: string,
    history: ChatMessage[],
    onDelta?: (delta: string) => void,
  ): Promise<AskResult> {
    const body = { contextId: this.session(), question, history };

    if (onDelta) {
      try {
        return await this.streamAsk(body, onDelta);
      } catch (err) {
        const failure = err as StreamFailure & AgentHttpError;
        // 已经渲染了部分正文就不能重来 —— 重放会把内容接成两段
        if (failure.emitted) throw err;
        /*
         * 服务端已经用状态码明确拒绝（400 参数错 / 410 会话失效 / 422 内容不可用）时，
         * 换一次性接口重发不会有不同结果 —— 只会白白多跑一次检索与模型调用，
         * 让用户多等十几秒才看到同一个错误。只有 5xx / 网络层失败才值得退一次。
         */
        if (typeof failure.status === 'number' && failure.status < 500) throw err;
        // 一个字都还没吐：静默退回一次性接口，保证问答不中断
        console.warn('[agent] 流式失败，退回一次性接口：', (err as Error).message);
      }
    }

    const r = await this.post<{ answer: string; sources?: string[]; expanded?: string[] }>(
      '/api/agent/ask',
      body,
    );
    return { answer: r.answer, sources: r.sources, expanded: r.expanded };
  }

  /** SSE 消费：把 sources / delta / error 事件还原成一次回答 */
  private async streamAsk(
    body: unknown,
    onDelta: (delta: string) => void,
  ): Promise<AskResult> {
    const res = await fetch(`${this.baseUrl}/api/agent/ask/stream`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) throw await this.toError(res);
    if (!res.body) throw new Error('服务端没有返回流式响应体');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let sources: string[] | undefined;
    let streamError: string | null = null;
    let emitted = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const line = rawEvent.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;

        let evt: { type?: string; text?: string; sources?: string[]; error?: string };
        try {
          evt = JSON.parse(payload) as typeof evt;
        } catch {
          continue;
        }

        if (evt.type === 'sources') sources = evt.sources ?? [];
        else if (evt.type === 'delta' && typeof evt.text === 'string') {
          answer += evt.text;
          emitted = true;
          onDelta(evt.text);
        } else if (evt.type === 'error') streamError = evt.error ?? '上游返回了未知错误';
      }
    }

    if (streamError) {
      const err = new Error(streamError) as StreamFailure;
      err.emitted = emitted;
      throw err;
    }
    if (!answer.trim()) throw new Error('模型没有返回任何内容，请重试');

    return { answer, sources };
  }

  nextChoiceQuestion(history: ChatMessage[]): Promise<ChoiceQuestion> {
    return this.post<ChoiceQuestion>('/api/agent/question', {
      contextId: this.session(),
      mode: 'choice',
      history,
    });
  }

  nextShortQuestion(history: ChatMessage[]): Promise<ShortQuestion> {
    return this.post<ShortQuestion>('/api/agent/question', {
      contextId: this.session(),
      mode: 'short',
      history,
    });
  }

  gradeChoice(question: ChoiceQuestion, selectedIndex: number): Promise<ChoiceGrade> {
    return this.post<ChoiceGrade>('/api/agent/grade', {
      contextId: this.session(),
      type: 'choice',
      questionId: question.id,
      selectedIndex,
    });
  }

  gradeShort(question: ShortQuestion, answer: string): Promise<ShortGrade> {
    return this.post<ShortGrade>('/api/agent/grade', {
      contextId: this.session(),
      type: 'short',
      questionId: question.id,
      // 题干要带上：模型批改时需要知道问了什么
      question: { id: question.id, prompt: question.prompt },
      answer,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 实现选择                                                            */
/* ------------------------------------------------------------------ */

export type AgentMode = 'mock' | 'http';

/**
 * 决定用哪个实现。
 *
 * 历史上这里默认 `mock`，而 `NEXT_PUBLIC_AGENT_MODE` 在客户端**未必被内联**
 * （构建时该变量缺失就会退化成运行时 `process.env` 查询，浏览器里恒为 undefined）。
 * 结果就是：服务端配好了 Key，线上却一直在跑前端联调模拟 —— 正是要修的这个坑。
 *
 * 现在的规则，按优先级：
 *  1. 用户填了自己的 API Key ⇒ 必须走真实后端，否则他的 Key 根本没机会被用到；
 *  2. 显式设了 `NEXT_PUBLIC_AGENT_MODE=mock` ⇒ 尊重它（本地联调用）；
 *  3. 其余情况一律走真实后端 —— 默认值不再偏向「假装能用」的模拟。
 */
export function resolveAgentMode(): AgentMode {
  if (getLlmSettings()) return 'http';

  const flag = process.env.NEXT_PUBLIC_AGENT_MODE;
  if (flag === 'mock') return 'mock';

  return 'http';
}

let cached: { mode: AgentMode; client: AgentClient } | null = null;

/** 获取当前模式下的 Agent 客户端实例（模式变了会自动换） */
export function getAgentClient(): AgentClient {
  const mode = resolveAgentMode();
  if (cached && cached.mode === mode) return cached.client;
  cached = { mode, client: mode === 'http' ? new HttpAgentClient() : new MockAgentClient() };
  return cached.client;
}

/** 丢弃缓存的客户端（测试与模式切换时用） */
export function resetAgentClient(): void {
  cached = null;
}
