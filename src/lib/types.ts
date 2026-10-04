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
}

/** 承载一道题目的消息（含作答结果） */
export interface QuestionMessage extends MessageBase {
  kind: 'question';
  question: Question;
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
 * Agent 客户端接口。
 * 前端只依赖这个接口：V1.0 前端联调用 MockAgentClient 实现，
 * 后端就绪后换成 HttpAgentClient（对接 /api/agent/*），页面代码零改动。
 */
export interface AgentClient {
  /** 解析 URL、建立问答上下文 */
  initContext(url: string): Promise<UrlContext>;

  /**
   * 提问模式：根据 URL 内容回答用户问题。
   * `onDelta` 可选 —— 传入时后端会走 SSE 逐段回传，前端可以边收边渲染。
   */
  ask(
    question: string,
    history: ChatMessage[],
    onDelta?: (delta: string) => void,
  ): Promise<AskResult>;

  /** 回答模式：主动生成下一道选择题 */
  nextChoiceQuestion(history: ChatMessage[]): Promise<ChoiceQuestion>;

  /** 回答模式：主动生成下一道简答题 */
  nextShortQuestion(history: ChatMessage[]): Promise<ShortQuestion>;

  /** 回答模式：判定选择题作答 */
  gradeChoice(question: ChoiceQuestion, selectedIndex: number): Promise<ChoiceGrade>;

  /** 回答模式：判定简答题作答 */
  gradeShort(question: ShortQuestion, answer: string): Promise<ShortGrade>;
}
