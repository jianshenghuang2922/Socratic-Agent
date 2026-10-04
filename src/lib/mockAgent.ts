import type {
  AgentClient,
  AskResult,
  ChatMessage,
  ChoiceGrade,
  ChoiceQuestion,
  Question,
  ShortGrade,
  ShortQuestion,
  UrlContext,
} from './types';
import { CODE_HOSTS, isRepoUrl } from './urlKind';

/**
 * MockAgentClient —— 纯前端联调用的模拟 Agent。
 *
 * 后端（CodeBuddy Agent SDK + RAG）尚未接入，先用它把前端交互闭环跑通：
 * 具备真实的异步延迟、流式打字、错误注入能力，接口与 HttpAgentClient 完全一致。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  async initContext(url: string): Promise<UrlContext> {
    await sleep(1400);
    const repo = isRepoUrl(url);
    this.lastWasRepo = repo;
    const kb = repo ? REPO_KNOWLEDGE : WEB_KNOWLEDGE;
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
  ): Promise<AskResult> {
    void _history;
    await sleep(900);
    const kb = this.lastWasRepo ? REPO_KNOWLEDGE : WEB_KNOWLEDGE;
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

    return { answer, sources: kb.facts.map((_, i) => `${kb.topic} › 段落 ${i + 1}`).slice(0, 3) };
  }

  async nextChoiceQuestion(_history: ChatMessage[]): Promise<ChoiceQuestion> {
    void _history;
    await sleep(1100);
    const q = CHOICE_BANK[this.choiceCursor % CHOICE_BANK.length];
    this.choiceCursor += 1;
    return { type: 'choice', ...q, options: [...q.options] };
  }

  async nextShortQuestion(_history: ChatMessage[]): Promise<ShortQuestion> {
    void _history;
    await sleep(1100);
    const q = SHORT_BANK[this.shortCursor % SHORT_BANK.length];
    this.shortCursor += 1;
    return { type: 'short', ...q };
  }

  async gradeChoice(question: ChoiceQuestion, selectedIndex: number): Promise<ChoiceGrade> {
    await sleep(800);
    const correctIndex = question.correctIndex ?? 0;
    return {
      correct: selectedIndex === correctIndex,
      correctIndex,
      explanation: question.explanation ?? '',
    };
  }

  async gradeShort(question: ShortQuestion, answer: string): Promise<ShortGrade> {
    await sleep(900);
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
    return { score, feedback, reference };
  }

  /**
   * 提示：只给思路，不给答案。
   * Mock 下没法真的读题干，给一句通用的启发式引导，保证前端链路能跑通。
   */
  async requestHint(question: Question): Promise<string> {
    await sleep(700);
    return question.type === 'choice'
      ? '先别急着排除选项：回到资料里确认这一步真正的职责是什么，再逐项对照 —— 与职责对得上的那个选项，描述里往往会出现资料原文中的关键词。'
      : '试着先想清楚「它一共做了哪几件事」，再按先后顺序把它们串起来；对照资料原文逐个核对，别漏掉中间那一步。';
  }
}
