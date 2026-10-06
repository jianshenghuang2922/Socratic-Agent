/**
 * 全局类型定义 —— 前端与 Agent 后端之间的契约。
 * 需求来源：《问答 Agent 前端需求文档 V1.0》
 */

/** 交互模式：提问模式（用户→Agent）/ 回答模式（Agent→用户） */
export type ChatMode = 'ask' | 'answer';

/** 回答模式下的题型：选择题 / 简答题 */
export type QuestionType = 'choice' | 'short';

/** 会话生命周期状态 */
export type SessionPhase =
  /** 尚未输入 URL，展示 URL 输入区 */
  | 'idle'
  /** 正在解析 URL、建立问答上下文 */
  | 'initializing'
  /** 上下文就绪，可以问答 */
  | 'ready';

/** 全局状态提示（状态提示区使用） */
export type StatusKind = 'idle' | 'loading' | 'thinking' | 'success' | 'error';

export interface StatusState {
  kind: StatusKind;
  text: string;
}

/**
 * 一条思考轨迹（服务端在生成过程中逐步下发）。
 *
 * 讲的是**管道里真实发生过的事**：查询扩展映射出了哪些标识符、
 * BM25 召回了什么、出题自检为什么没过要重出。
 * 刻意不依赖模型原生的思维链 —— 当前网关跑的是非推理模型，
 * 上游根本不返回 reasoning_content，把体验押在它上面等于随时白屏。
 */
export interface TraceEvent {
  /** 展示分组：检索 / 出题 / 判分 / 提示 / 生成 */
  stage: string;
  /** 一句话说明刚发生了什么 */
  detail: string;
}

/** 一次 Agent 动作的轨迹记录 */
export interface AgentTrace {
  /** 本次动作的执行过程，按发生顺序 */
  steps: TraceEvent[];
  /** 执行中，后续还会有新步骤 */
  live: boolean;
  /** 已结束（成功或失败），面板自动收起 */
  done: boolean;
}

/** URL 上下文：建立成功后由后端返回 */
export interface UrlContext {
  url: string;
  /** 解析出的标题，用于头部展示 */
  title: string;
  /** 摘要，可选，用于让用户确认解析正确 */
  summary?: string;
  /** 内容规模（字数/文件数等），可选 */
  size?: number;
  /** 检索索引的语义块数 —— 即「可检索范围」 */
  chunks?: number;
}

/* ------------------------------------------------------------------ */
/* 消息模型                                                            */
/* ------------------------------------------------------------------ */

/** 选择题的结构化数据 */
export interface ChoiceQuestion {
  type: 'choice';
  /**
   * 服务端生成的题目 id。
   * 正确答案留在服务端，判分时靠这个 id 找回答案键，因此前端拿不到答案。
   */
  id?: string;
  prompt: string;
  options: string[];
  /** 用户已选项下标；未作答时为 undefined */
  selectedIndex?: number;
  /** 是否已提交 */
  submitted?: boolean;
  /**
   * 因题型切换被作废。
   * 卡片仍留在历史里（便于回看），但不再接受作答，也不参与「当前题」判定。
   */
  abandoned?: boolean;
  /** 提交后由 Agent 返回 */
  correctIndex?: number;
  explanation?: string;
  /**
   * 「给点提示」返回的引导文案。
   * 只引导思路，不含正确答案，也**不代表已作答** —— 提示后仍可正常提交。
   */
  hint?: string;
  /** 出题时依据的资料块标签（RAG 溯源） */
  sources?: string[];
}

/** 简答题的结构化数据 */
export interface ShortQuestion {
  type: 'short';
  /** 服务端生成的题目 id，作用同 ChoiceQuestion.id */
  id?: string;
  prompt: string;
  /** 用户填写的答案 */
  answer?: string;
  submitted?: boolean;
  /** 因题型切换被作废，含义同 ChoiceQuestion.abandoned */
  abandoned?: boolean;
  /** 提交后由 Agent 返回：AI 按要点覆盖度给出的得分（0 ~ 5 的整数） */
  score?: number;
  feedback?: string;
  /** 参考答案 */
  reference?: string;
  /** 「给点提示」返回的引导文案，含义同 ChoiceQuestion.hint */
  hint?: string;
  /** 出题时依据的资料块标签（RAG 溯源） */
  sources?: string[];
}

export type Question = ChoiceQuestion | ShortQuestion;

interface MessageBase {
  id: string;
  role: 'user' | 'agent';
  ts: number;
}

/** 普通文本气泡 */
export interface TextMessage extends MessageBase {
  kind: 'text';
  content: string;
  /** 这条回答依据的资料块标签（仅提问模式的 Agent 回答有） */
  sources?: string[];
  /** 产出这条回答时的思考过程，收进折叠面板回看 */
  trace?: TraceEvent[];
}

/** 承载一道题目的消息（含作答结果） */
export interface QuestionMessage extends MessageBase {
  kind: 'question';
  question: Question;
  /** 产出这道题时的思考过程，收进折叠面板回看 */
  trace?: TraceEvent[];
}

/** 系统提示（如「已切换模式」「URL 已更新」） */
export interface NoticeMessage extends MessageBase {
  kind: 'notice';
  content: string;
}

export type ChatMessage = TextMessage | QuestionMessage | NoticeMessage;

/* ------------------------------------------------------------------ */
/* Agent 客户端契约                                                    */
/* ------------------------------------------------------------------ */

/** 选择题判分结果 */
export interface ChoiceGrade {
  correct: boolean;
  correctIndex: number;
  explanation: string;
}

/** 简答题判分结果：由 AI 按要点覆盖度打分，而不是「对/错」二分 */
export interface ShortGrade {
  /** AI 判定的得分，0 ~ 5 的整数 */
  score: number;
  feedback: string;
  reference: string;
}

/** 提问模式的回答结果 */
export interface AskResult {
  /** 回答正文 */
  answer: string;
  /** 本次回答依据了哪些资料块（RAG 溯源），前端用于展示「依据」 */
  sources?: string[];
  /** 中文提问被映射到哪些项目标识符（排查检索效果用） */
  expanded?: string[];
}

/**
 * 引用来源的可查看详情 —— 「点开引用文件直接查看」的载荷。
 *
 * 前端手里只有一串标签（如 `lib/core/Axios.js › interceptor`），
 * 光看标签判断不了「它到底是不是有据可查」。这里把标签还原成能直接读的内容。
 */
export interface SourceView {
  /** 原始标签，与 sources 数组里的元素逐字一致 */
  label: string;
  /** 内容来自哪类来源 */
  kind: 'web' | 'repo';
  /** 块的类型，决定查看器用等宽（代码 / 配置）还是正常排版（文档） */
  category: 'code' | 'doc' | 'config' | 'meta';
  /** 展示标题：代码仓库为文件路径，网页为页面标题 */
  title: string;
  /** 被引用的章节 / 符号锚点，可能为空 */
  anchor: string | null;
  /** 可查看的正文 */
  text: string;
  /**
   * 被引用的那一段在 `text` 中的字符区间。
   * 仓库是把整份文件拼回来给的，不标出「引用的是哪一段」，用户就得自己找。
   */
  focus?: { start: number; end: number };
  /** 原文链接：网页为页面地址，代码仓库为托管站的文件页（推不出来时为空） */
  externalUrl?: string;
  /** 正文是否被服务端的返回上限截断 */
  truncated?: boolean;
  /** 正文由几个索引块重组而来（> 1 说明是拼回来的，可能与源文件有细微差异） */
  chunks: number;
}

/* ------------------------------------------------------------------ */
/* 分享测验                                                            */
/* ------------------------------------------------------------------ */

/**
 * 分享出去的一道题 —— **不含答案**。
 *
 * 与 ChoiceQuestion 的区别：那份是「自己会话里的题」，带 selectedIndex /
 * submitted / correctIndex 等作答态字段；这份是给陌生人做的一次性快照，
 * 服务端只下发题干与选项，答案键留在服务端。
 */
export interface SharedQuestion {
  id: string;
  prompt: string;
  options: string[];
  /** 出题时依据的资料块标签，让做题的人知道这题是从哪儿来的 */
  sources?: string[];
}

/** 一条分享链接指向的整套测验 */
export interface SharedQuizView {
  id: string;
  /** 来源标题，展示成「N 道题来自《xxx》」 */
  title: string;
  /** 原始 URL，做题的人可以点回去看原文 */
  sourceUrl: string;
  /** 题目数（= questions.length，单独给是为了渲染标题时不必先算长度） */
  count: number;
  /** 已有多少人做过（按去重后的做题者计，不是页面打开次数） */
  players: number;
  questions: SharedQuestion[];
}

/** 分享测验里一道题的判分结果 */
export interface SharedQuizGrade {
  correct: boolean;
  correctIndex: number;
  explanation: string;
}

/** 生成分享链接的结果 */
export interface SharedQuizLink {
  quizId: string;
  title: string;
  /** 原始内容地址（不是测验链接 —— 测验链接由前端按 origin + /quiz/{quizId} 拼） */
  sourceUrl: string;
  count: number;
  players: number;
}

/**
 * 思考轨迹的接收器。
 * 服务端每完成一个中间步骤就回调一次，前端据此实时渲染。
 */
export type TraceHandler = (event: TraceEvent) => void;

/**
 * Agent 客户端接口。
 * 前端只依赖这个接口：V1.0 前端联调用 MockAgentClient 实现，
 * 后端就绪后换成 HttpAgentClient（对接 /api/agent/*），页面代码零改动。
 *
 * `onTrace` 贯穿所有方法：它是「等待时用户看什么」的唯一来源。
 * 不传时行为与改造前完全一致（静默等待），因此对调用方是纯增量的。
 */
export interface AgentClient {
  /**
   * 解析 URL、建立问答上下文。
   *
   * `onTrace` 可选 —— 传入时会收到「克隆仓库 / 抓取网页 / 切块建索引」的中间过程。
   * 这一步是整个应用里最长的等待（仓库要浅克隆，超时上限 180s），
   * 不把过程讲出来，用户只能对着一个不动的 spinner 猜是不是卡死了。
   */
  initContext(url: string, onTrace?: TraceHandler): Promise<UrlContext>;

  /**
   * 提问模式：根据 URL 内容回答用户问题。
   * `onDelta` 可选 —— 传入时后端会走 SSE 逐段回传，前端可以边收边渲染。
   * `onTrace` 可选 —— 传入时会额外收到服务端的中间步骤。
   */
  ask(
    question: string,
    history: ChatMessage[],
    onDelta?: (delta: string) => void,
    onTrace?: TraceHandler,
  ): Promise<AskResult>;

  /** 回答模式：主动生成下一道选择题 */
  nextChoiceQuestion(history: ChatMessage[], onTrace?: TraceHandler): Promise<ChoiceQuestion>;

  /** 回答模式：主动生成下一道简答题 */
  nextShortQuestion(history: ChatMessage[], onTrace?: TraceHandler): Promise<ShortQuestion>;

  /** 回答模式：判定选择题作答 */
  gradeChoice(
    question: ChoiceQuestion,
    selectedIndex: number,
    onTrace?: TraceHandler,
  ): Promise<ChoiceGrade>;

  /** 回答模式：判定简答题作答 */
  gradeShort(question: ShortQuestion, answer: string, onTrace?: TraceHandler): Promise<ShortGrade>;

  /**
   * 回答模式：卡住时请求一个提示。
   * 与判分互不相干 —— 只返回启发式引导（不给答案），不改动作答状态、不计分。
   */
  requestHint(question: Question, onTrace?: TraceHandler): Promise<string>;

  /**
   * 取回某条引用来源的完整内容，供用户点开查看。
   *
   * `label` 就是 ask / 出题结果里 `sources` 数组的元素。
   * 服务端只在**已建好的会话索引块**里查表 —— 不重新抓网页、不读磁盘，
   * 所以这是个廉价操作，不需要 onTrace。
   */
  getSource(label: string): Promise<SourceView>;

  /**
   * 把这次会话里已出的选择题打包成一条可分享链接。
   *
   * 为什么值得单独做一个动作：做完题是个死胡同 —— 用户唯一的「下一步」是关掉页面。
   * 给他一条能发到群里的链接，链路才从「一个人用」变成「一群人用」。
   *
   * 这个动作**不调模型、不占额度**：分享的内容是已经生成好的题目与答案键，
   * 判分是纯服务端整数比对（见 src/server/quiz.ts）。别人做一百遍也不花钱。
   */
  shareQuiz(): Promise<SharedQuizLink>;
}
