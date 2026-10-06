import { MockAgentClient } from './mockAgent';
import { getLlmHeaders, getLlmSettings } from './llmSettings';
import { publishTrial, type TrialQuota } from './trial';
import type {
  AgentClient,
  AskResult,
  ChatMessage,
  ChoiceGrade,
  ChoiceQuestion,
  Question,
  ShortGrade,
  ShortQuestion,
  SourceView,
  SharedQuizLink,
  TraceEvent,
  TraceHandler,
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
  /** 服务端标记「这次失败值得换一批资料重试」（如出题自检没过），与网络类失败区分开 */
  retryable?: boolean;
  /** 机器可读的失败分类，例如 trial_exhausted */
  code?: string;
}

/** 服务端明确返回过状态码的失败（区别于网络中断 / 流被掐断） */
interface AgentHttpError extends Error {
  status?: number;
  /** 机器可读的失败分类，例如 trial_exhausted */
  code?: string;
}

/**
 * HttpAgentClient —— 对接真实后端的实现。
 *
 * 后端接口（均为 POST，JSON，统一返回 { error } 作为失败体）：
 *   POST /api/agent/context/stream { url }                           -> SSE（建上下文 + 进度）
 *   POST /api/agent/context      { url }                             -> { contextId, … }（同上，一次性）
 *   POST /api/agent/ask/stream   { contextId, question, history }     -> SSE
 *     { contextId, mode, history }                                    -> SSE（出题）
 *     { contextId, action:'question' | 'hint' | 'grade', ... }        -> SSE
 *   POST /api/agent/ask          { contextId, question, history }     -> { answer, sources, expanded }（流式不可用时的退路）
 *   POST /api/agent/question     { contextId, mode, history }         -> ChoiceQuestion | ShortQuestion（同上）
 *   POST /api/agent/hint         { contextId, type, questionId }      -> { hint }（同上）
 *   POST /api/agent/source       { contextId, label }                 -> SourceView（引用来源详情）
 *
 * 注：`POST /api/agent/grade` 仍保留（对外契约不变），但客户端已不再使用 ——
 * 判分统一走流式，否则思考轨迹无从下发。详见 gradeChoice 的说明。
 *
 * 关键设计：contextId 由 initContext 拿到后**存在客户端实例内部**，
 * 后续每次请求自动带上。这样 AgentClient 接口不用为「会话 id」开洞，
 * 页面层完全无感知。正确答案始终留在服务端，前端只能拿到题干。
 *
 * 为什么所有动作都优先走 SSE：用户等待时最想看的是思考过程，
 * 而思考只存在于生成过程中。一次性接口只能等到最后给个结果，
 * 中间几十秒完全是黑盒。SSE 换来的不只是流式正文，还有逐步下发的思考轨迹。
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
    let code: string | undefined;
    try {
      const payload = (await res.json()) as { error?: string; code?: string; trial?: TrialQuota };
      if (payload?.error) message = payload.error;
      code = payload?.code;
      /*
       * 额度类错误会把最新计数一起带回来，就地刷新。
       * 这样前端收到 429 的同一刻就把「还剩 N 次」改成 0，
       * 不必再打一次 /config —— 那一次往返恰好发生在用户最不耐烦的时刻。
       */
      publishTrial(payload?.trial);
    } catch {
      /* 非 JSON 响应，保留状态码描述 */
    }
    // 会话/题目已失效：清掉本地 contextId，避免后续请求继续撞同一个 410
    if (res.status === 410) this.contextId = null;
    const err = new Error(message) as AgentHttpError;
    // 带上状态码：调用方据此判断「换接口重发有没有意义」
    err.status = res.status;
    err.code = code;
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

  /**
   * 建立上下文。
   *
   * 走流式（`/api/agent/context/stream`）而不是一次性接口：这是全流程里最长的
   * 一段等待 —— 代码仓库要浅克隆（超时上限 180s）再扫描、切块、建索引，
   * 一次性接口在这期间给不出任何信息。
   *
   * 刻意**不留一次性退路**：SSE 在本应用里是既有前提（提问 / 出题 / 判分 /
   * 提示全走 SSE），它要是不可用，整个应用本来就用不了。留一条静默退路只会
   * 让「流式坏了」再次变成无人察觉的隐性故障（`ask` 就踩过这个坑）。
   */
  async initContext(url: string, onTrace?: TraceHandler): Promise<UrlContext> {
    const { result } = await this.streamRequest<ContextResponse>(
      { url },
      { onTrace },
      '/api/agent/context/stream',
    );
    if (!result) throw new Error('服务端没有返回上下文信息');
    this.contextId = result.contextId;
    return { url: result.url, title: result.title, summary: result.summary, size: result.size, chunks: result.chunks };
  }

  /**
   * SSE 读取器 —— 所有动作共用一个消费循环。
   *
   * 事件类型：trace（思考轨迹）/ sources / delta / result（结构化结果）/ error。
   * 之所以不做成「每种动作一个解析函数」，是因为协议本身是同一套；
   * 分成三份只会让「trace 忘了转发」这类 bug 有机会藏在某一份里。
   */
  private async streamRequest<T>(
    body: Record<string, unknown>,
    handlers: {
      onDelta?: (delta: string) => void;
      onTrace?: TraceHandler;
    },
    path = '/api/agent/ask/stream',
  ): Promise<{ result: T | null; sources?: string[]; answer: string }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
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
    let result: T | null = null;
    let streamError: string | null = null;
    let streamErrorCode: string | undefined;
    let retryable = false;
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

        let evt: {
          type?: string;
          text?: string;
          stage?: string;
          detail?: string;
          sources?: string[];
          result?: T;
          error?: string;
          retryable?: boolean;
          code?: string;
          /** 服务端在每个动作结束时顺路带下来的最新额度 */
          trial?: TrialQuota;
        };
        try {
          evt = JSON.parse(payload) as typeof evt;
        } catch {
          continue;
        }

        if (evt.type === 'trace' && typeof evt.detail === 'string') {
          // 轨迹是体验增强，回调抛错绝不能拖垮整条流
          try {
            handlers.onTrace?.({ stage: evt.stage ?? '思考', detail: evt.detail });
          } catch {
            /* 忽略渲染侧异常 */
          }
        } else if (evt.type === 'sources') sources = evt.sources ?? [];
        else if (evt.type === 'delta' && typeof evt.text === 'string') {
          answer += evt.text;
          emitted = true;
          handlers.onDelta?.(evt.text);
        } else if (evt.type === 'result' && evt.result !== undefined) {
          result = evt.result;
        } else if (evt.type === 'quota') {
          // 额度是旁路信息，订阅方自己处理，不影响本次请求的结果
          publishTrial(evt.trial);
        } else if (evt.type === 'error') {
          streamError = evt.error ?? '上游返回了未知错误';
          retryable = evt.retryable === true;
          streamErrorCode = evt.code;
        }
      }
    }

    if (streamError) {
      const err = new Error(streamError) as StreamFailure;
      // emitted：已经吐过字就不能悄悄重来。retryable：服务端自检类失败可换一批资料重试
      err.emitted = emitted;
      err.retryable = retryable;
      err.code = streamErrorCode;
      throw err;
    }

    return { result, sources, answer };
  }

  async ask(
    question: string,
    history: ChatMessage[],
    onDelta?: (delta: string) => void,
    onTrace?: TraceHandler,
  ): Promise<AskResult> {
    const body = { contextId: this.session(), question, history };

    // 有 onDelta 或 onTrace 之一就必须走流式 —— 轨迹只在流里有
    if (onDelta || onTrace) {
      try {
        const { answer, sources } = await this.streamRequest<never>(body, { onDelta, onTrace });
        if (!answer.trim()) throw new Error('模型没有返回任何内容，请重试');
        return { answer, sources };
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

  /** 出题：一次尝试。自检类失败（重复 / 不够具体）标记为可重试，由调用方换资料再来一次 */
  private async fetchQuestion(
    mode: 'choice' | 'short',
    history: ChatMessage[],
    attempt: number,
    onTrace?: TraceHandler,
  ): Promise<ChoiceQuestion | ShortQuestion> {
    const body = {
      contextId: this.session(),
      action: 'question',
      mode,
      history,
      attempt,
    };
    const { result } = await this.streamRequest<ChoiceQuestion | ShortQuestion>(body, { onTrace });
    if (!result) throw new Error('服务端没有返回题目');
    return result;
  }

  async nextChoiceQuestion(history: ChatMessage[], onTrace?: TraceHandler): Promise<ChoiceQuestion> {
    const q = await this.fetchQuestion('choice', history, 0, onTrace);
    return q as ChoiceQuestion;
  }

  async nextShortQuestion(history: ChatMessage[], onTrace?: TraceHandler): Promise<ShortQuestion> {
    const q = await this.fetchQuestion('short', history, 0, onTrace);
    return q as ShortQuestion;
  }

  /** 出题时上游允许的最大尝试次数，与 /api/agent/ask/stream 的 MAX_QUESTION_ATTEMPTS 一致 */
  static readonly MAX_QUESTION_ATTEMPTS = 3;
  /** 换一批资料拉开距离用的步长，同样与服务端约定 */
  private retryStep = 3;

  /**
   * 出题重试：服务端只跑一次尝试，循环放在这里。
   *
   * 把循环放在前端是为了**等待的可见性** —— 每轮都能先把「上一版为什么不合格」
   * 讲给用户听，等待被切成看得懂的段落；放在服务端则是一个静默转圈几十秒的黑盒。
   * 轮次参数（attempt）决定了服务端换哪一批资料采样。
   *
   * 不写成泛型：泛型方法在「接口 + 两种实现」的联合类型下互不兼容，
   * 调用点会直接报 not callable。用返回联合类型的宽签名，调用方各自收窄即可。
   */
  async nextQuestionWithRetry(
    mode: 'choice' | 'short',
    history: ChatMessage[],
    onTrace?: TraceHandler,
  ): Promise<ChoiceQuestion | ShortQuestion> {
    let lastError: unknown;
    for (let attempt = 0; attempt < HttpAgentClient.MAX_QUESTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.fetchQuestion(mode, history, attempt, onTrace);
      } catch (err) {
        lastError = err;
        const failure = err as StreamFailure;
        // 只有服务端明确说了「可重试」才继续；会话失效、网关故障重试没有意义
        if (!failure.retryable) throw err;
      }
    }
    throw lastError;
  }

  /**
   * 选择题判分。
   *
   * 走流式而不是一次性接口 —— 不是为了流式正文（判分没有正文），
   * 而是**一次性接口结构上就发不出思考轨迹**：它只有最后一个 JSON，
   * 中间步骤全部被吞在服务端。判分本身是零延迟的服务端比对，
   * 但走流式让「判分依据」这条轨迹能被下发与归档，
   * 也让判分与简答题共用同一条管道（少一条会各自漂移的重复实现）。
   */
  gradeChoice(
    question: ChoiceQuestion,
    selectedIndex: number,
    onTrace?: TraceHandler,
  ): Promise<ChoiceGrade> {
    return this.gradeChoiceStream(question, selectedIndex, onTrace);
  }

  private async gradeChoiceStream(
    question: ChoiceQuestion,
    selectedIndex: number,
    onTrace?: TraceHandler,
  ): Promise<ChoiceGrade> {
    const { result } = await this.streamRequest<ChoiceGrade>(
      {
        contextId: this.session(),
        action: 'grade',
        type: 'choice',
        questionId: question.id,
        selectedIndex,
      },
      { onTrace },
    );
    if (!result) throw new Error('服务端没有返回判分结果');
    return result;
  }

  gradeShort(
    question: ShortQuestion,
    answer: string,
    onTrace?: TraceHandler,
  ): Promise<ShortGrade> {
    return this.gradeShortStream(question, answer, onTrace);
  }

  private async gradeShortStream(
    question: ShortQuestion,
    answer: string,
    onTrace?: TraceHandler,
  ): Promise<ShortGrade> {
    const { result } = await this.streamRequest<ShortGrade>(
      {
        contextId: this.session(),
        action: 'grade',
        type: 'short',
        questionId: question.id,
        // 题干要带上：模型批改时需要知道问了什么
        question: { id: question.id, prompt: question.prompt },
        answer,
      },
      { onTrace },
    );
    if (!result) throw new Error('服务端没有返回判分结果');
    return result;
  }

  /** 卡住时的提示：只拿回引导文案，不改动本地作答状态 */
  async requestHint(question: Question, onTrace?: TraceHandler): Promise<string> {
    const { result } = await this.streamRequest<{ hint: string }>(
      {
        contextId: this.session(),
        action: 'hint',
        type: question.type,
        questionId: question.id,
        question: { id: question.id, prompt: question.prompt },
      },
      { onTrace },
    );
    if (!result?.hint) throw new Error('服务端没有返回提示');
    return result.hint;
  }

  /**
   * 取回引用来源的完整内容。
   *
   * 走一次性接口而不是 SSE：服务端只是在自己的索引块里按标签查表，
   * 没有任何中间步骤可讲 —— 套上流式只会多一层解析，换不来等待期的信息。
   */
  async getSource(label: string): Promise<SourceView> {
    return this.post<SourceView>('/api/agent/source', { contextId: this.session(), label });
  }

  /**
   * 生成分享链接。
   *
   * 走一次性接口而不是 SSE：服务端只是把已存的题目换个容器装起来，
   * 没有任何中间步骤可讲（不调模型、不检索），套上流式只会多一层解析。
   */
  async shareQuiz(): Promise<SharedQuizLink> {
    return this.post<SharedQuizLink>('/api/agent/quiz', { contextId: this.session() });
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

let cached: { mode: AgentMode; client: HttpAgentClient | MockAgentClient } | null = null;

/**
 * 获取当前模式下的 Agent 客户端实例（模式变了会自动换）。
 * 返回具体类而非接口，纯粹是为了让回归脚本能调用 nextQuestionWithRetry。
 */
export function getAgentClient(): HttpAgentClient | MockAgentClient {
  const mode = resolveAgentMode();
  if (cached && cached.mode === mode) return cached.client;
  cached = { mode, client: mode === 'http' ? new HttpAgentClient() : new MockAgentClient() };
  return cached.client;
}

/** 丢弃缓存的客户端（测试与模式切换时用） */
export function resetAgentClient(): void {
  cached = null;
}
