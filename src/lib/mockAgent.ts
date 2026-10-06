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
  TraceHandler,
  UrlContext,
} from './types';
import { CODE_HOSTS, isRepoUrl } from './urlKind';

/**
 * MockAgentClient —— 纯前端联调用的模拟 Agent。
 *
 * 后端（CodeBuddy Agent SDK + RAG）尚未接入，先用它把前端交互闭环跑通：
 * 具备真实的异步延迟、流式打字、错误注入能力，接口与 HttpAgentClient 完全一致。
 *
 * 它也**照常产出思考轨迹** —— 否则本地联调时思考面板永远是空的，
 * 「面板有没有真的接上」这件事就没法在前端侧验证。
 * 轨迹内容与真实后端同构（检索 → 生成），只是文案写成模拟态。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 按真实节奏逐条吐轨迹，让面板的「逐步出现」效果在 mock 下也能看到 */
async function* mockTrace(
  steps: { stage: string; detail: string }[],
  gap = 320,
): AsyncGenerator<{ stage: string; detail: string }> {
  for (const step of steps) {
    await sleep(gap);
    yield step;
  }
}

async function playTrace(
  steps: { stage: string; detail: string }[],
  onTrace?: TraceHandler,
  gap = 320,
): Promise<void> {
  if (!onTrace) return;
  for await (const step of mockTrace(steps, gap)) onTrace(step);
}

/** 从 URL 推断一个可读的标题，让 Mock 的反馈看起来是「基于该 URL」的 */
function deriveTitle(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    const base = u.hostname.replace(/^www\./, '');
    // 代码仓库：owner/repo
    if (CODE_HOSTS.includes(base) && segs.length >= 2) {
      return `${decodeURIComponent(segs[0])}/${decodeURIComponent(segs[1])}`;
    }
    const seg = segs.pop();
    return seg ? `${base} / ${decodeURIComponent(seg)}` : base;
  } catch {
    return url;
  }
}

/** Mock 的「知识库」——模拟从 URL 解析出的内容 */
const WEB_KNOWLEDGE = {
  topic: '基于文档的问答系统（RAG）',
  facts: [
    '系统首先把目标 URL 的正文抓取并切分成若干语义段落（chunk）。',
    '每个段落经过 Embedding 模型编码后写入向量库，形成可检索的上下文。',
    '用户提问时，问题同样被编码，并在向量库中召回最相关的 Top-K 段落。',
    '召回结果与问题一起拼进 Prompt，交给大模型生成最终回答。',
    '回答模式则反向：由模型基于上下文主动出题，再对用户作答进行判分。',
  ],
};

const REPO_KNOWLEDGE = {
  topic: '代码仓库结构分析',
  facts: [
    '仓库先被克隆到隔离目录，再遍历文件树并按语言、目录归类。',
    '关键文件（入口、配置、路由、核心模块）会被优先抽取为高权重片段。',
    '每个代码片段连同文件路径与符号名一起编码，写入向量库。',
    '提问时按语义相似度召回代码片段，并把路径与上下文一并提供给模型。',
    '回答模式则反向：由模型基于仓库内容出题，再对用户作答进行判分。',
  ],
};

const CHOICE_BANK: Omit<ChoiceQuestion, 'type'>[] = [
  {
    prompt: '在基于文档的问答系统中，把长文档切分成语义段落的主要目的是什么？',
    options: [
      '减少存储占用',
      '让检索能精确定位到相关内容片段',
      '加快网页加载速度',
      '统一文档格式',
    ],
    correctIndex: 1,
    explanation:
      '切分是为了让向量检索的粒度足够细，从而在提问时召回真正相关的内容片段，而不是整篇文档。',
  },
  {
    prompt: '用户提问后，系统在向量库中执行的操作是？',
    options: [
      '把问题翻译成英文',
      '对问题进行编码并召回最相关的 Top-K 段落',
      '直接返回全文',
      '重新抓取网页',
    ],
    correctIndex: 1,
    explanation:
      '问题会被同一套 Embedding 模型编码成向量，再通过相似度检索召回最相关的 Top-K 段落作为上下文。',
  },
  {
    prompt: '为什么召回结果要和原始问题一起拼进 Prompt？',
    options: [
      '为了让模型知道该依据哪些材料作答',
      '为了凑够 Token 数量',
      '为了隐藏真实问题',
      '没有实际作用',
    ],
    correctIndex: 0,
    explanation:
      '模型本身不知道文档内容，必须把召回的材料作为上下文一并提供，才能基于事实作答。',
  },
  {
    prompt: '回答模式与提问模式最本质的区别是？',
    options: [
      '使用的模型不同',
      '问答双方的角色方向相反：由 Agent 主动出题',
      '回答模式不需要文档上下文',
      '回答模式只能出选择题',
    ],
    correctIndex: 1,
    explanation:
      '两种模式共用同一份上下文，区别在于主动方：提问模式由用户驱动，回答模式由 Agent 驱动。',
  },
];

const SHORT_BANK: Omit<ShortQuestion, 'type'>[] = [
  {
    prompt: '请简述「检索增强生成（RAG）」的基本流程。',
    reference:
      '抓取并切分文档 → 编码写入向量库 → 用户提问时召回 Top-K 相关段落 → 将问题与召回内容拼接为 Prompt → 大模型生成回答。',
  },
  {
    prompt: '为什么在基于文档的问答中，直接让大模型回答而不提供文档内容是不可靠的？',
    reference:
      '模型没有文档中的事实信息，只能依赖训练语料推测，容易产生幻觉；提供召回上下文才能让回答有据可依。',
  },
  {
    prompt: '如果召回结果与问题无关，可能有哪些原因？',
    reference:
      '切分粒度不合理、Embedding 模型与语料不匹配、Top-K 取值过小、文档本身缺少相关信息等。',
  },
];

/** 关键词覆盖度的粗糙打分（0 ~ 5），仅用于 Mock */
function roughScore(answer: string, reference: string): number {
  const norm = (s: string) => s.replace(/[\s，。、；：？！,.;:?!]/g, '');
  const a = norm(answer);
  if (a.length < 4) return 0;
  const keys = reference
    .split(/[→、；。]/)
    .map((s) => s.replace(/[^\u4e00-\u9fa5A-Za-z]/g, ''))
    .filter((s) => s.length >= 2)
    .slice(0, 6);
  if (keys.length === 0) return 3;
  const hit = keys.filter((k) => a.includes(k.slice(0, 2))).length;
  return Math.max(0, Math.min(5, Math.round((hit / keys.length) * 5)));
}

export class MockAgentClient implements AgentClient {
  private choiceCursor = 0;
  private shortCursor = 0;
  private lastWasRepo = false;
  /** 记下最近一次解析的地址，分享测验时要用它当来源 */
  private lastUrl = '';
  /** 模拟「对同一会话幂等」：重复生成复用同一个 id */
  private mockQuizId: string | null = null;

  async initContext(url: string, onTrace?: TraceHandler): Promise<UrlContext> {
    const repo = isRepoUrl(url);
    this.lastWasRepo = repo;
    this.lastUrl = url;
    this.mockQuizId = null;
    const kb = repo ? REPO_KNOWLEDGE : WEB_KNOWLEDGE;

    // 与真实后端同构：准备 → 抓取/克隆 → 扫描 → 切块 → 建索引
    await playTrace(
      repo
        ? [
            { stage: '准备', detail: '识别为代码仓库地址：将浅克隆仓库、扫描文本文件并建立代码索引。' },
            { stage: '克隆', detail: `正在浅克隆 ${deriveTitle(url)}…（只取最新一次提交，超时上限 180s）` },
            { stage: '克隆', detail: '克隆完成（耗时 1s），正在扫描文件树…' },
            { stage: '扫描', detail: `扫描到 ${kb.facts.length * 12} 个可索引的文本文件（已跳过依赖 / 产物 / 二进制目录）。` },
            { stage: '索引', detail: '已按文件价值排序（README / 配置 / 入口文件优先），开始逐文件切块建索引…' },
            { stage: '索引', detail: `纳入 ${kb.facts.length * 8} 个文件，切分为 ${kb.facts.length * 3} 个语义块（模拟）。` },
          ]
        : [
            { stage: '准备', detail: '识别为网页地址：将抓取页面、抽取正文并建立文档索引。' },
            { stage: '抓取', detail: '已确认目标站点是公网地址，正在请求该网页…（模拟）' },
            { stage: '抓取', detail: '已收到响应：HTTP 200，text/html，正在读取正文…' },
            { stage: '解析', detail: '已剥离脚本 / 样式标签，抽取出正文文本。' },
            { stage: '切分', detail: `正文 ${kb.facts.length * 800} 字，按标题层级切分为 ${kb.facts.length * 3} 个语义块（模拟）。` },
          ],
      onTrace,
      260,
    );

    await sleep(600);
    return {
      url,
      title: deriveTitle(url),
      summary: repo
        ? `已克隆并解析该代码仓库，主题：${kb.topic}。共提取 ${kb.facts.length} 类核心片段作为问答上下文。`
        : `已解析该网页的正文内容，主题：${kb.topic}。共提取 ${kb.facts.length} 个核心段落作为问答上下文。`,
      size: 12800,
      chunks: 24,
    };
  }

  async ask(
    question: string,
    _history: ChatMessage[],
    onDelta?: (delta: string) => void,
    onTrace?: TraceHandler,
  ): Promise<AskResult> {
    void _history;
    const kb = this.lastWasRepo ? REPO_KNOWLEDGE : WEB_KNOWLEDGE;

    await playTrace(
      [
        { stage: '检索', detail: `正在把提问映射到该项目真实存在的标识符（模拟）。` },
        { stage: '检索', detail: `把中文概念映射到项目标识符：chunk / embedding / topK（模拟）。` },
        { stage: '检索', detail: `召回 ${kb.facts.length} 个资料块，最相关的是「${kb.topic} › 段落 1」（高度相关）。` },
        { stage: '生成', detail: '资料已就位，开始逐字作答…' },
      ],
      onTrace,
    );

    await sleep(400);
    const fact = kb.facts[Math.floor(Math.random() * kb.facts.length)];
    const answer = [
      `针对「${question}」的回答如下：`,
      '',
      fact,
      '',
      `（当前为前端联调的模拟回答。接入真实 Agent 后，此处会由大模型基于召回的内容片段生成。）`,
    ].join('\n');

    // 模拟流式：按小块吐字，让前端的增量渲染逻辑在 mock 下也能跑通
    if (onDelta) {
      const step = 6;
      for (let i = 0; i < answer.length; i += step) {
        await sleep(28);
        onDelta(answer.slice(i, i + step));
      }
    }

    onTrace?.({ stage: '生成', detail: '回答完成。' });
    return { answer, sources: kb.facts.map((_, i) => `${kb.topic} › 段落 ${i + 1}`).slice(0, 3) };
  }

  async nextChoiceQuestion(_history: ChatMessage[], onTrace?: TraceHandler): Promise<ChoiceQuestion> {
    void _history;
    await this.emitQuestionTrace('选择题', onTrace);
    await sleep(400);
    const q = CHOICE_BANK[this.choiceCursor % CHOICE_BANK.length];
    this.choiceCursor += 1;
    return { type: 'choice', ...q, options: [...q.options] };
  }

  async nextShortQuestion(_history: ChatMessage[], onTrace?: TraceHandler): Promise<ShortQuestion> {
    void _history;
    await this.emitQuestionTrace('简答题', onTrace);
    await sleep(400);
    const q = SHORT_BANK[this.shortCursor % SHORT_BANK.length];
    this.shortCursor += 1;
    return { type: 'short', ...q };
  }

  private async emitQuestionTrace(type: string, onTrace?: TraceHandler): Promise<void> {
    await playTrace(
      [
        { stage: '出题', detail: '还没有历史错题可参考，本轮完全按项目内容均匀取材（模拟）。' },
        { stage: '出题', detail: '跨全项目均匀采样 6 个资料块（第 1 轮，起点已错开）。' },
        { stage: '出题', detail: `正在让模型按资料出题（题型：${type}，第 1 版）。` },
        { stage: '出题', detail: '自检通过：题干锚定了资料中的具体名称，与历史题目也不重复。' },
        { stage: '出题', detail: '题目已生成，正确答案已锁在服务端（前端拿不到，无法作弊）。' },
      ],
      onTrace,
    );
  }

  /**
   * 出题重试：与 HttpAgentClient 同形，但 mock 从不「自检失败」。
   * 保留这个方法是为了让 hook 只依赖一种调用方式，
   * 不必在两条实现之间分叉重试逻辑。
   *
   * 刻意用非泛型的宽签名（返回联合类型），与 HttpAgentClient 保持一致 ——
   * 两个来源的泛型方法在联合类型下互不兼容，hook 里会直接报「not callable」。
   */
  nextQuestionWithRetry(
    mode: 'choice' | 'short',
    history: ChatMessage[],
    onTrace?: TraceHandler,
  ): Promise<ChoiceQuestion | ShortQuestion> {
    void history;
    return mode === 'choice'
      ? this.nextChoiceQuestion([], onTrace)
      : this.nextShortQuestion([], onTrace);
  }

  async gradeChoice(
    question: ChoiceQuestion,
    selectedIndex: number,
    onTrace?: TraceHandler,
  ): Promise<ChoiceGrade> {
    await playTrace(
      [{ stage: '判分', detail: '选择题由服务端直接比对答案，无需调用模型（零延迟、判定确定）。' }],
      onTrace,
      200,
    );
    await sleep(600);
    const correctIndex = question.correctIndex ?? 0;
    const correct = selectedIndex === correctIndex;
    onTrace?.({
      stage: '判分',
      detail: correct
        ? '比对你的选择与答案键：一致，判定为正确。'
        : `比对你的选择与答案键：不一致，判定为错误，正确答案是 ${String.fromCharCode(
            65 + correctIndex,
          )}。`,
    });
    return {
      correct,
      correctIndex,
      explanation: question.explanation ?? '',
    };
  }

  async gradeShort(
    question: ShortQuestion,
    answer: string,
    onTrace?: TraceHandler,
  ): Promise<ShortGrade> {
    await playTrace(
      [
        { stage: '判分', detail: '正在按参考答案拆解采分点，再逐条核对你答到了哪些（模拟）。' },
        { stage: '检索', detail: '召回 2 个资料块用于核对要点（模拟）。' },
      ],
      onTrace,
      240,
    );
    await sleep(500);
    const reference = question.reference ?? '';
    const score = roughScore(answer, reference);
    const feedback =
      score >= 5
        ? '要点覆盖完整，表述准确。'
        : score >= 4
          ? '覆盖了绝大部分要点，仅有个别遗漏。'
          : score >= 3
            ? '方向正确，但遗漏了部分要点。'
            : score >= 1
              ? '只答到了一两个要点，建议对照参考答案补齐。'
              : '作答与参考答案的关键要点不符，建议重新组织。';
    onTrace?.({ stage: '判分', detail: `采分点覆盖度核算完毕：得 ${score} / 5 分。` });
    onTrace?.({ stage: '判分', detail: '这次作答已记入你的学习档案，后续出题会针对薄弱点换角度再问。' });
    return { score, feedback, reference };
  }

  /**
   * 提示：只给思路，不给答案。
   * Mock 下没法真的读题干，给一句通用的启发式引导，保证前端链路能跑通。
   */
  async requestHint(question: Question, onTrace?: TraceHandler): Promise<string> {
    await playTrace(
      [
        { stage: '提示', detail: '正在取回这道题的答案要点，用来判断引导方向（不会直接告诉你答案）。' },
        { stage: '提示', detail: '正在生成引导：只指思路方向，划死线不给答案、不排除到只剩一个。' },
      ],
      onTrace,
      280,
    );
    await sleep(400);
    const hint =
      question.type === 'choice'
        ? '先别急着排除选项：回到资料里确认这一步真正的职责是什么，再逐项对照 —— 与职责对得上的那个选项，描述里往往会出现资料原文中的关键词。'
        : '试着先想清楚「它一共做了哪几件事」，再按先后顺序把它们串起来；对照资料原文逐个核对，别漏掉中间那一步。';
    onTrace?.({ stage: '提示', detail: '引导已就绪（仅启发思路，作答状态与计分不受影响）。' });
    return hint;
  }

  /**
   * 引用来源详情。
   *
   * Mock 下没有真实索引可查，就按标签合成一份同构的内容 ——
   * 关键不是内容像不像真的，而是**形状必须和真实后端一致**
   * （kind / title / anchor / focus / chunks 都得到位），
   * 否则查看器在本地联调时走的分支和线上不一样，「点开能不能用」就验不出来。
   */
  async getSource(label: string): Promise<SourceView> {
    await sleep(220);

    const i = label.indexOf('›');
    const filePart = (i < 0 ? label : label.slice(0, i)).trim();
    const anchor = i < 0 ? null : label.slice(i + 1).trim() || null;

    const kb = this.lastWasRepo ? REPO_KNOWLEDGE : WEB_KNOWLEDGE;

    if (!this.lastWasRepo) {
      return {
        label,
        kind: 'web',
        category: 'doc',
        title: filePart,
        anchor,
        text: kb.facts.join('\n\n'),
        externalUrl: 'https://example.local/mock-doc',
        chunks: 1,
      };
    }

    // 仓库：两块拼成「整份文件」，并标出被引用的那一段 —— 与真实后端的形态对齐
    const head = `/* ${filePart} —— 模拟文件内容 */\n// Mock 只用于联调，内容不代表真实仓库。`;
    const cited = kb.facts[0];
    const tail = kb.facts.slice(1).join('\n\n');
    const text = [head, cited, tail].join('\n\n');

    return {
      label,
      kind: 'repo',
      category: 'code',
      title: filePart,
      anchor,
      text,
      // 被引用的就是中间那段
      focus: { start: head.length + 2, end: head.length + 2 + cited.length },
      externalUrl: undefined,
      chunks: 3,
    };
  }

  /**
   * 生成分享链接。
   *
   * Mock 下没有服务端可存题目，返回一个形状一致的结果即可 ——
   * 关键是**幂等**：重复调用必须给同一个 quizId，
   * 否则「点两次得到两条链接」这类 bug 在本地联调时根本看不出来。
   */
  async shareQuiz(): Promise<SharedQuizLink> {
    await sleep(240);
    this.mockQuizId ??= `mock-${Math.random().toString(36).slice(2, 10)}`;
    return {
      quizId: this.mockQuizId,
      title: deriveTitle(this.lastUrl || 'https://example.local/mock'),
      sourceUrl: this.lastUrl || 'https://example.local/mock',
      count: Math.max(1, this.choiceCursor),
      players: 0,
    };
  }
}
