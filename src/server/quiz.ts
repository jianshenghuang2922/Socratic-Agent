/**
 * 可分享的测验 —— 把一次会话里的选择题打包成一条链接，别人打开就能做同一套题。
 *
 * 为什么只共享**选择题**：
 *   判分是拿 selectedIndex 和答案键做整数比较，零延迟、零 LLM 调用。
 *   也就是说这个分享回路**边际成本为零** —— 别人做一百遍也不烧一分钱额度。
 *   简答题要靠模型批改，每做一次就是一次真实的上游调用，
 *   用它做分享等于把服务端账号配额直接暴露给陌生人。所以第一版不做。
 *
 * 答案键只存在服务端：GET 下发的题目里没有 correctIndex，
 * 和主流程「答案绝不下发」的口径保持一致 —— 别为了省一次往返把答案塞进前端。
 */

import { randomBytes } from 'node:crypto';
import { ApiError } from './http';
import type { StoredContext } from './store';
import type { SharedQuestion, SharedQuizGrade, SharedQuizView } from '@/lib/types';

interface StoredAnswer {
  correctIndex: number;
  explanation: string;
}

export interface SharedQuiz {
  id: string;
  /** 来源标题，展示成「N 道题来自「xxx」」 */
  title: string;
  sourceUrl: string;
  createdAt: number;
  /**
   * 做过的**人**（去重后的做题者 id），不是页面打开次数。
   *
   * 为什么按人去重而不是按请求计数：分享出去的链接会被群里的机器人、
   * 预览抓取、用户刷新反复打开，按请求计会得到一个虚高到没意义的数字，
   * 反而让分享者以为「很多人做过」。
   */
  players: Set<string>;
  questions: SharedQuestion[];
  /** questionId -> 答案键。**只在服务端** */
  answers: Map<string, StoredAnswer>;
}

interface QuizStore {
  quizzes: Map<string, SharedQuiz>;
}

/**
 * 挂在 globalThis 上，理由同 store.ts：
 * Next.js 开发模式会热重载模块，模块级变量被清空 → 刚分享出去的链接立刻 404。
 */
declare global {
  // eslint-disable-next-line no-var
  var __socraticQuizzes: QuizStore | undefined;
}

const store: QuizStore = (globalThis.__socraticQuizzes ??= { quizzes: new Map() });

/**
 * 分享链接的存活时长，比会话长得多。
 * 会话是 2 小时（用户自己用），分享链接是要发到群里被人隔几天点开的。
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 最多同时保留多少套测验 */
const MAX_QUIZZES = 200;
/** 一套测验最多多少题 —— 再多做题的人不会做完，payload 也没必要那么大 */
const MAX_QUESTIONS = 20;

function sweep(now: number): void {
  for (const [id, q] of store.quizzes) {
    if (now - q.createdAt > TTL_MS) store.quizzes.delete(id);
  }
  if (store.quizzes.size > MAX_QUIZZES) {
    const ordered = [...store.quizzes.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const q of ordered.slice(0, store.quizzes.size - MAX_QUIZZES)) {
      store.quizzes.delete(q.id);
    }
  }
}

/** 短 id：URL 友好、看不出规律，11 个字符足够 */
function newQuizId(): string {
  return randomBytes(8).toString('base64url');
}

/**
 * 把会话里的选择题打包成一套测验。
 *
 * 对同一个会话是**幂等**的：重复点击只会更新内容、复用同一个 id。
 * 不这样做的话用户双击一下就得到两条链接，群里发出去的到底是哪一条就说不清了。
 */
export function publishQuiz(ctx: StoredContext): SharedQuiz {
  const now = Date.now();
  sweep(now);

  const questions: SharedQuestion[] = [];
  const answers = new Map<string, StoredAnswer>();

  for (const [questionId, key] of ctx.answers) {
    // 只挑选择题：简答题没有 correctIndex，而且它的批改要调模型（见文件头说明）
    if (typeof key.correctIndex !== 'number') continue;
    if (!key.prompt?.trim() || !key.options?.length) continue;
    if (questions.length >= MAX_QUESTIONS) break;

    questions.push({
      id: questionId,
      prompt: key.prompt,
      options: key.options,
      sources: key.sourceLabels,
    });
    answers.set(questionId, {
      correctIndex: key.correctIndex,
      explanation: key.explanation ?? '',
    });
  }

  if (!questions.length) {
    throw new ApiError(
      400,
      '这次会话里还没有选择题可以分享。切到「回答模式」并选择「选择题」，出几道题之后再来生成测验链接。',
    );
  }

  const existing = ctx.quizId ? store.quizzes.get(ctx.quizId) : undefined;
  if (existing) {
    // 复用 id：链接不变，内容跟上最新进度
    existing.questions = questions;
    existing.answers = answers;
    existing.title = ctx.title;
    existing.sourceUrl = ctx.url;
    return existing;
  }

  const quiz: SharedQuiz = {
    id: newQuizId(),
    title: ctx.title,
    sourceUrl: ctx.url,
    createdAt: now,
    players: new Set(),
    questions,
    answers,
  };
  store.quizzes.set(quiz.id, quiz);
  ctx.quizId = quiz.id;
  return quiz;
}

/**
 * 组装下发给做题者的载荷。
 *
 * 单独抽出来是为了让「哪些字段能出去」只有一处定义 ——
 * 哪天有人往 SharedQuiz 里加了新字段，也必须在这里显式决定要不要下发，
 * 而不是因为整个对象被 JSON 化就顺手漏出去（答案键就是这么漏的）。
 */
export function toQuizView(quiz: SharedQuiz): SharedQuizView {
  return {
    id: quiz.id,
    title: quiz.title,
    sourceUrl: quiz.sourceUrl,
    count: quiz.questions.length,
    players: quiz.players.size,
    questions: quiz.questions,
  };
}

export function getQuiz(id: string | undefined): SharedQuiz | undefined {
  if (!id) return undefined;
  sweep(Date.now());
  return store.quizzes.get(id);
}

export function requireQuiz(id: string | undefined): SharedQuiz {
  const quiz = getQuiz(id);
  if (!quiz) {
    throw new ApiError(404, '这个测验链接不存在或已过期（有效期 7 天）。');
  }
  return quiz;
}

/**
 * 记一个做题的人。
 *
 * 只在**判分**时记，不在 GET 题目时记 —— 打开页面不等于做过题，
 * 预览抓取、爬虫、用户点开又关掉都会产生 GET。判分才是「真的做了」的证据。
 */
export function countPlayer(quiz: SharedQuiz, playerId: string | undefined): void {
  if (!playerId) return;
  // 上限兜底：一个被刷的链接不该把内存吃光
  if (quiz.players.size >= 10_000) return;
  quiz.players.add(playerId);
}

/**
 * 判分。
 *
 * 与主流程的选择题判分是同一套口径（纯整数比对），但**不写任何用户记忆** ——
 * 做题的人连会话都没有，写进哪儿都不对。这里只回结果。
 */
export function gradeQuizAnswer(
  quiz: SharedQuiz,
  questionId: string,
  selectedIndex: number,
): SharedQuizGrade {
  const answer = quiz.answers.get(questionId);
  if (!answer) throw new ApiError(404, '这道题不属于该测验，或链接已更新。');

  const question = quiz.questions.find((q) => q.id === questionId);
  const optionCount = question?.options.length ?? 0;
  // 越界下标不报错的话只会静默判成「错」，做题的人会以为自己选错了
  if (selectedIndex < 0 || (optionCount > 0 && selectedIndex >= optionCount)) {
    throw new ApiError(400, `selectedIndex 超出选项范围（0 ~ ${optionCount - 1}）`);
  }

  return {
    correct: selectedIndex === answer.correctIndex,
    correctIndex: answer.correctIndex,
    explanation: answer.explanation,
  };
}

/** 统计（用于调试端点） */
export function quizStats() {
  let players = 0;
  for (const q of store.quizzes.values()) players += q.players.size;
  return { quizzes: store.quizzes.size, players };
}
