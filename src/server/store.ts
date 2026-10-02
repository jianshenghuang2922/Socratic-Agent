import { randomUUID } from 'node:crypto';
import { ApiError } from './http';
import { BM25Index, buildIndex } from './retrieve';
import type { SourceBlock } from './sources/types';

/**
 * 题目答案键 —— 只存在服务端。
 * 前端拿到的题目对象里不含正确答案，避免用户直接翻出答案。
 */
export interface AnswerKey {
  /** 题干原文 —— 判分时用来回填用户记忆 */
  prompt?: string;
  /** 选择题选项原文，用于把 selectedIndex 还原成人话 */
  options?: string[];
  /** 选择题：正确选项下标 */
  correctIndex?: number;
  /** 选择题：解析 */
  explanation?: string;
  /** 简答题：参考答案 */
  reference?: string;
  /** 出题时依据的资料块标签，判分时回填进用户记忆 */
  sourceLabels?: string[];
}

export type Verdict = 'correct' | 'partial' | 'incorrect';

/**
 * 一次「用户回复」的完整记录。
 *
 * 这是 RAG 里被检索的**第二类内容**：用户自己的作答。
 * 有了它，问答才能针对这个人的薄弱点展开，而不是每次都从零开始八股式提问。
 */
export interface Interaction {
  id: string;
  questionId: string;
  /** 当时的题干 */
  prompt: string;
  /** 用户作答（选择题存选项文本） */
  userAnswer: string;
  correct: boolean;
  verdict: Verdict;
  /** 题目知识点所在的资料块标签，用于回捞原文 */
  sourceLabels: string[];
  /** 服务端给出的解析 / 参考答案 —— 也进索引，用户之后可以检索到 */
  knowledge: string;
  ts: number;
}

/** 提问模式下用户问过的问题，同样进索引 */
export interface UserQuery {
  text: string;
  ts: number;
}

export interface StoredContext {
  id: string;
  url: string;
  kind: 'web' | 'repo';
  title: string;
  summary: string;
  /** 解析出的正文，兜底用 */
  content: string;
  /** 结构化块 —— 检索的数据源 */
  blocks: SourceBlock[];
  createdAt: number;
  /** 题目 id -> 答案键。只存在服务端，不下发给前端 */
  answers: Map<string, AnswerKey>;
  /** 用户作答历史 */
  interactions: Interaction[];
  /** 用户提问历史 */
  userQueries: UserQuery[];
  /** 惰性构建的检索索引（项目内容 + 用户回复） */
  index?: BM25Index;
  /** 查询扩展缓存：原查询 -> 映射到的项目标识符 */
  expansions?: Map<string, string[]>;
}

/** 会话存活时长 */
const TTL_MS = 2 * 60 * 60 * 1000;
/** 最多同时保留多少个会话 */
const MAX_CONTEXTS = 50;
/** 单会话最多保留多少条用户作答记录 */
const MAX_INTERACTIONS = 200;

interface Store {
  contexts: Map<string, StoredContext>;
}

/**
 * 挂在 globalThis 上。
 * Next.js 开发模式会热重载模块，普通模块级变量会被清空，导致刚建好的上下文凭空消失。
 */
declare global {
  // eslint-disable-next-line no-var
  var __socraticStore: Store | undefined;
}

const store: Store = (globalThis.__socraticStore ??= { contexts: new Map() });

function sweep(): void {
  const now = Date.now();
  for (const [id, ctx] of store.contexts) {
    if (now - ctx.createdAt > TTL_MS) store.contexts.delete(id);
  }
  // 仍然超量时，按创建时间淘汰最旧的
  if (store.contexts.size > MAX_CONTEXTS) {
    const ordered = [...store.contexts.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const ctx of ordered.slice(0, store.contexts.size - MAX_CONTEXTS)) {
      store.contexts.delete(ctx.id);
    }
  }
}

export function createContext(
  data: Omit<
    StoredContext,
    'id' | 'createdAt' | 'answers' | 'interactions' | 'userQueries' | 'index' | 'expansions'
  >,
): StoredContext {
  sweep();
  const ctx: StoredContext = {
    ...data,
    id: randomUUID(),
    createdAt: Date.now(),
    answers: new Map(),
    interactions: [],
    userQueries: [],
  };
  store.contexts.set(ctx.id, ctx);
  return ctx;
}

export function getContext(id: string | undefined): StoredContext | undefined {
  if (!id) return undefined;
  sweep();
  return store.contexts.get(id);
}

/** 取上下文，取不到就抛 410 —— 前端会提示用户重新输入 URL */
export function requireContext(id: string | undefined): StoredContext {
  const ctx = getContext(id);
  if (!ctx) {
    throw new ApiError(410, '会话已过期或不存在，请重新输入 URL 建立上下文');
  }
  return ctx;
}

export function saveAnswerKey(contextId: string, questionId: string, key: AnswerKey): void {
  const ctx = getContext(contextId);
  if (!ctx) return;
  // 单会话内最多留 200 道题的答案键
  if (ctx.answers.size >= 200) {
    const oldest = ctx.answers.keys().next().value;
    if (oldest) ctx.answers.delete(oldest);
  }
  ctx.answers.set(questionId, key);
}

export function getAnswerKey(contextId: string, questionId: string): AnswerKey | undefined {
  return getContext(contextId)?.answers.get(questionId);
}

export function newQuestionId(): string {
  return randomUUID();
}

/* ------------------------------------------------------------------ */
/* 用户回复：写入并进索引                                               */
/* ------------------------------------------------------------------ */

/** 把一条交互记录转成可检索的文本 */
function interactionText(it: Interaction): string {
  return [
    `题目：${it.prompt}`,
    `我的作答：${it.userAnswer}`,
    `判定：${it.verdict === 'correct' ? '正确' : it.verdict === 'partial' ? '部分正确' : '错误'}`,
    it.knowledge ? `解析：${it.knowledge}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function toBlock(it: Interaction): SourceBlock {
  return {
    label: `我的作答记录 › ${it.prompt.slice(0, 40)}`,
    path: ['我的作答记录', it.correct ? '答对' : '答错'],
    text: interactionText(it),
    category: 'meta',
  };
}

/**
 * 记录一次用户作答，并把它加进检索索引。
 * 索引是增量的 —— 不重建，避免每次作答都重新分词整个项目。
 */
export function recordInteraction(contextId: string, input: Omit<Interaction, 'id' | 'ts'>): void {
  const ctx = getContext(contextId);
  if (!ctx) return;

  const it: Interaction = { ...input, id: randomUUID(), ts: Date.now() };
  ctx.interactions.push(it);
  if (ctx.interactions.length > MAX_INTERACTIONS) ctx.interactions.shift();

  ctx.index?.add({
    id: `memory-${it.id}`,
    label: `我的作答记录 › ${it.prompt.slice(0, 40)}`,
    path: ['我的作答记录', it.correct ? '答对' : '答错'],
    text: interactionText(it),
    origin: 'memory',
  });
}

/** 记录提问模式下用户问过的问题 */
export function recordUserQuery(contextId: string, text: string): void {
  const ctx = getContext(contextId);
  if (!ctx) return;

  const trimmed = text.trim();
  if (!trimmed) return;
  ctx.userQueries.push({ text: trimmed, ts: Date.now() });
  if (ctx.userQueries.length > 200) ctx.userQueries.shift();

  ctx.index?.add({
    id: `query-${ctx.userQueries.length}-${Date.now()}`,
    label: `我提过的问题 › ${trimmed.slice(0, 40)}`,
    path: ['我提过的问题'],
    text: `我问过：${trimmed}`,
    origin: 'memory',
  });
}

/* ------------------------------------------------------------------ */
/* 检索索引                                                            */
/* ------------------------------------------------------------------ */

/**
 * 取该会话的检索索引，没有就构建。
 * 索引覆盖「项目内容 + 用户回复」两类 —— 这正是需求里说的
 * 「项目内容和用户回复作为检索增强内容」。
 */
export function getIndex(ctx: StoredContext): BM25Index {
  if (ctx.index) return ctx.index;

  const index = buildIndex(ctx.blocks, 'project');
  for (const it of ctx.interactions) {
    index.add({
      id: `memory-${it.id}`,
      label: toBlock(it).label,
      path: toBlock(it).path,
      text: interactionText(it),
      origin: 'memory',
    });
  }
  for (let i = 0; i < ctx.userQueries.length; i += 1) {
    const q = ctx.userQueries[i];
    index.add({
      id: `query-${i}`,
      label: `我提过的问题 › ${q.text.slice(0, 40)}`,
      path: ['我提过的问题'],
      text: `我问过：${q.text}`,
      origin: 'memory',
    });
  }

  ctx.index = index;
  return index;
}

/**
 * 薄弱点：答错或部分正确的题目。
 * 出题时优先针对这些知识点换角度再问，而不是随机出题。
 */
export function weakSpots(ctx: StoredContext, limit = 6): Interaction[] {
  const weak = ctx.interactions.filter((it) => !it.correct);
  // 优先最近的、以及部分正确的（差一点，值得再练）
  return weak.slice(-limit).reverse();
}

export function storeStats() {
  const contexts = [...store.contexts.values()];
  return {
    contexts: contexts.length,
    interactions: contexts.reduce((n, c) => n + c.interactions.length, 0),
    indexedChunks: contexts.reduce((n, c) => n + (c.index?.size ?? 0), 0),
  };
}
