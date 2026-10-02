import { MockAgentClient } from './mockAgent';
import type {
  AgentClient,
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

/**
 * HttpAgentClient —— 对接真实后端的实现。
 *
 * 后端接口（均为 POST，JSON，统一返回 { error } 作为失败体）：
 *   POST /api/agent/context   { url }                              -> { contextId, url, kind, title, summary }
 *   POST /api/agent/ask       { contextId, question, history }     -> { answer }
 *   POST /api/agent/question  { contextId, mode, history }         -> ChoiceQuestion | ShortQuestion
 *   POST /api/agent/grade     { contextId, type, questionId, ... } -> ChoiceGrade | ShortGrade
 *
 * 关键设计：contextId 由 initContext 拿到后**存在客户端实例内部**，
 * 后续每次请求自动带上。这样 AgentClient 接口不用为「会话 id」开洞，
 * 页面层完全无感知。正确答案始终留在服务端，前端只能拿到题干。
 */
export class HttpAgentClient implements AgentClient {
  private contextId: string | null = null;

  constructor(private readonly baseUrl = '') {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
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
      throw new Error(message);
    }

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

  async ask(question: string, history: ChatMessage[]): Promise<string> {
    const r = await this.post<{ answer: string }>('/api/agent/ask', {
      contextId: this.session(),
      question,
      history,
    });
    return r.answer;
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

let cached: AgentClient | null = null;

/** 获取全局唯一的 Agent 客户端实例 */
export function getAgentClient(): AgentClient {
  if (cached) return cached;
  const mode = process.env.NEXT_PUBLIC_AGENT_MODE ?? 'mock';
  cached = mode === 'http' ? new HttpAgentClient() : new MockAgentClient();
  return cached;
}
