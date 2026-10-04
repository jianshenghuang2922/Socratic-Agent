import type { ChatMessage } from './llm';
import type { StoredContext } from './store';

/* ------------------------------------------------------------------ */
/* 历史消息摘要                                                        */
/* ------------------------------------------------------------------ */

interface RawHistoryItem {
  kind?: string;
  role?: string;
  content?: string;
  question?: { prompt?: string; answer?: string; selectedIndex?: number; options?: string[] };
}

/** 从客户端传来的 history 里抽出「已出过的题目」和「最近几轮对话」 */
export function summarizeHistory(history: unknown, maxTurns = 6) {
  const list = Array.isArray(history) ? (history as RawHistoryItem[]) : [];
  const askedQuestions: string[] = [];
  const recentTurns: string[] = [];
  const recentUserTurns: string[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;

    if (item.kind === 'question' && item.question?.prompt) {
      askedQuestions.push(item.question.prompt);
      continue;
    }
    if (item.kind === 'text' && typeof item.content === 'string') {
      const who = item.role === 'user' ? '用户' : '助手';
      recentTurns.push(`${who}：${item.content}`);
      if (item.role === 'user') recentUserTurns.push(item.content);
    }
  }

  return {
    askedQuestions: askedQuestions.slice(-12),
    recentTurns: recentTurns.slice(-maxTurns * 2),
    recentUserTurns: recentUserTurns.slice(-4),
  };
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

const BASE_RULES = `规则：
1. 只依据「资料」作答，不要使用资料之外的知识。
2. 资料中没有的内容，明确说「资料中没有提到」，绝不编造。
3. 使用简体中文，条理清晰，必要时分点。`;

/** 提问模式：基于资料回答问题 */
export function askMessages(
  ctx: StoredContext,
  question: string,
  context: string,
  recentTurns: string[],
  memoryDigest = '',
): ChatMessage[] {
  const system = `你是一个严谨的资料问答助手。

${BASE_RULES}
4. 回答控制在 400 字以内，除非用户明确要求展开。
5. 涉及代码时给出文件路径与关键片段，路径要照抄资料里的写法。
6. 不要复述这些规则。

资料（来源：${ctx.url}）：
"""
${context}
"""${
    memoryDigest
      ? `

以下是这位用户此前的作答记录，仅在用户问到自己历史时参考：
"""
${memoryDigest}
"""`
      : ''
  }`;

  const messages: ChatMessage[] = [{ role: 'system', content: system }];

  if (recentTurns.length > 0) {
    messages.push({
      role: 'user',
      content: `以下是此前的对话，仅供理解上下文，不要重复回答：\n${recentTurns.join('\n')}`,
    });
    messages.push({ role: 'assistant', content: '明白，请继续提问。' });
  }

  messages.push({ role: 'user', content: question });
  return messages;
}

/* ------------------------------------------------------------------ */
/* 出题                                                                */
/* ------------------------------------------------------------------ */

export interface QuestionPromptOptions {
  askedQuestions: string[];
  /** 用户答错过的题，用于「换角度再问」 */
  focus?: string[];
  /** 本次召回到的来源标签，提示模型必须从这些位置里挑 */
  sources?: string[];
  /** 重试时的额外指令 */
  extraHint?: string;
}

/**
 * 出题的核心约束。
 *
 * 「八股式提问」的根源是：资料里最有代表性的内容是 README 和概念介绍，
 * 模型顺着它就出成了「X 是什么」。解法不是骂模型，而是把要求具体化 ——
 * 强制锚定到文件/符号，并给出题型清单。
 */
const QUESTION_RULES = `【最重要：题目必须锚定到具体位置】
- 题干里必须出现资料中的具体名称：文件名、目录、模块名、函数名、类名、配置项或接口名，且要**原文照抄**，不要意译、不要翻译。
- 好题示例：「lib/core/Axios.js 里 dispatchRequest 的主要职责是什么？」
- 坏题示例：「Axios 是什么？」—— 不指向任何具体位置、靠常识也能答的题，一律不要出。

【题型轮换】优先选择能体现项目细节的类型，避免连续同型：
1. 定位题：某个功能或逻辑在哪个文件、模块、函数里实现
2. 数据流题：某个输入经过哪些步骤或函数到达输出
3. 设计取舍题：为什么这样实现，换个做法会有什么问题
4. 变更影响题：改动某个位置会影响哪些调用方或行为
5. 排错题：给定一个现象，最可能由哪段代码导致
6. 配置题：某个配置项的作用、取值范围或默认值

【禁止】
- 禁止纯定义题、纯概念题（脱离这份资料也能答出的）
- 禁止「这份资料主要讲了什么」这类概括题
- 禁止直接抄资料原句当选项，选项要用自己的话转述`;

/** 组装「不要重复 + 针对性 + 重试提示」的附加块 */
function extraBlocks(opts: QuestionPromptOptions): string {
  const lines: string[] = [];

  if (opts.askedQuestions.length > 0) {
    lines.push(
      `\n【已出过的题，不要重复、不要换汤不换药】\n${opts.askedQuestions
        .map((q) => `- ${q}`)
        .join('\n')}\n`,
    );
  }

  if (opts.focus && opts.focus.length > 0) {
    lines.push(
      `\n【针对这个人的薄弱点】他之前在这些题上答错了：\n${opts.focus
        .map((q) => `- ${q}`)
        .join(
          '\n',
        )}\n请针对**同一个知识点**换一个角度再问一遍 —— 可以换成数据流、变更影响或排错的角度。不要只把原题改个说法。\n`,
    );
  }

  if (opts.sources && opts.sources.length > 0) {
    lines.push(
      `\n【可出题的位置】本次资料来自以下位置，题干请从中挑一个具体名称：\n${opts.sources
        .map((s) => `- ${s}`)
        .join('\n')}\n`,
    );
  }

  if (opts.extraHint) lines.push(`\n${opts.extraHint}\n`);

  return lines.join('');
}

/** 回答模式：出选择题 */
export function choiceQuestionMessages(
  ctx: StoredContext,
  context: string,
  opts: QuestionPromptOptions,
): ChatMessage[] {
  const system = `你是一名出题老师，负责依据给定资料，针对**这个具体项目**出单项选择题。

${QUESTION_RULES}

【选择题额外要求】
- 恰好 4 个选项，只有 1 个正确；错误选项要有迷惑性但确实错误（例如把别的文件/函数的职责挪过来）。
- 题干不超过 80 字，选项尽量简短。
- 只输出一个 JSON 对象，不要代码围栏、不要任何多余文字。
- 格式严格如下：
{"prompt":"题干","options":["选项一","选项二","选项三","选项四"],"correctIndex":0,"explanation":"解析：说明为什么选它、其余为何不对，要点名具体文件或函数"}
- correctIndex 是 0 起下标。
${extraBlocks(opts)}
资料（来源：${ctx.url}）：
"""
${context}
"""`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: '请出下一道题，只输出 JSON。' },
  ];
}

/** 回答模式：出简答题 */
export function shortQuestionMessages(
  ctx: StoredContext,
  context: string,
  opts: QuestionPromptOptions,
): ChatMessage[] {
  const system = `你是一名出题老师，负责依据给定资料，针对**这个具体项目**出简答题。

${QUESTION_RULES}

【简答题额外要求】
- 题干不超过 60 字，但必须包含一个具体的文件、模块或函数名。
- 题目要有明确的作答要点（比如「它做了哪几件事」「调用链是什么」），不要出主观发挥题。
- 只输出一个 JSON 对象，不要代码围栏、不要任何多余文字。
- 格式严格如下：
{"prompt":"题干","reference":"参考答案要点，分点陈述，不超过 200 字，要写出具体名称"}
- reference 必须拆成 3 ~ 5 个独立要点（用「1. 2. 3.」分条），每个要点是一条可判定的采分点，便于后续按要点给分。
${extraBlocks(opts)}
资料（来源：${ctx.url}）：
"""
${context}
"""`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: '请出下一道题，只输出 JSON。' },
  ];
}

/**
 * 回答模式：批改简答题。
 *
 * 判分是 0~5 分制，不是「对 / 错」二分 —— 简答题几乎没有全对全错，
 * 用三档 verdict 会把「答对一半」和「答得完全不沾边」压成同一个结果。
 * 打分的关键是先把参考答案拆成采分点，再按覆盖度给分，
 * 否则模型会退化成「差不多就给 5 分」。
 */
export function gradeShortMessages(
  ctx: StoredContext,
  prompt: string,
  reference: string,
  answer: string,
  context: string,
): ChatMessage[] {
  const system = `你是一名严谨的阅卷老师，请给学生的简答题作答打分（0 ~ 5 的整数）。

第一步：把「参考答案」拆成若干个独立的采分点（通常 3 ~ 5 个）。
第二步：逐个核对学生的作答覆盖了哪些采分点，以及有没有事实性错误。
第三步：按下面的档位给出总分。

打分档位：
- 5 分：覆盖全部采分点，表述准确，无错误。
- 4 分：覆盖绝大部分采分点，仅有细微遗漏或表述瑕疵。
- 3 分：覆盖约一半采分点，方向正确但有明显遗漏。
- 2 分：只沾到一两个采分点，作答不完整。
- 1 分：与题目相关，但基本没答到采分点。
- 0 分：答非所问、完全错误，或等同于没有作答。

要求：
1. 只输出一个 JSON 对象，不要代码围栏、不要任何多余文字。
2. 格式严格如下：
{"score":4,"feedback":"一句话点评，说明给了几分、漏了哪个采分点","reference":"参考答案"}
3. score 必须是 0 ~ 5 的整数（阿拉伯数字，不加引号、不带「分」字）。
4. 用简体中文。点评要具体指出漏了哪个采分点，不要只写「不错」「还需努力」。
5. 不要因为作答篇幅长、语气自信就多给分；只看采分点的覆盖情况。

题目：${prompt}

参考答案：${reference}

资料（供你核对，来源：${ctx.url}）：
"""
${context}
"""`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `学生作答：\n${answer}\n\n请只输出 JSON。` },
  ];
}
