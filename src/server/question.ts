/**
 * 出题 —— 单次尝试。
 *
 * 抽成独立模块，是因为它有两个调用方：
 *   · `POST /api/agent/ask/stream`（action:'question'）—— 前端走这条，重试由前端逐轮驱动
 *   · `POST /api/agent/question`                        —— 一次性版本，自己循环 3 次
 *
 * 这两条曾经各写一份，结果就是「流式那边改好了、一次性那边还是旧逻辑」：
 * 旧的一次性路由仍用「整句词元重合率 ≥ 0.6」判重，把两道考不同函数的题
 * （同属一个文件）一律判成重复，连着重试三次后 502。回归脚本打的正是那条路由，
 * 于是「修好了」和「没修好」在回归里同时成立 —— 典型的双实现漂移。
 *
 * 所以这里只保留**一份**：解析模型输出、判重、锚定校验、写答案键。
 * 谁需要重试，谁自己循环。
 */

import type { LlmOverride } from './config';
import { limits } from './config';
import { ApiError } from './http';
import { chat, extractJson } from './llm';
import { choiceQuestionMessages, shortQuestionMessages } from './prompts';
import { contextForQuestion } from './rag';
import { tokenize, tokenizeIdentifiers } from './retrieve';
import { newQuestionId, saveAnswerKey, type StoredContext } from './store';
import { emitTrace, shortenLabel, type TraceSink } from './trace';

/** 最多出几次（含首次）。流式那边由前端逐轮驱动，一次性那边自己循环 */
export const MAX_QUESTION_ATTEMPTS = 3;

/**
 * 判「重复题」的阈值 —— 口径是**标识符词元**的重合度，不是整句重合度。
 *
 * 原实现拿整句算「交集 / 较短一方」，而同一批资料出的题天然共用句式，
 * 于是两道考不同函数的题（`isFetchSupported` vs `contentTypeHeader`，
 * 同属 lib/adapters/fetch.js）重合率高达 0.7~0.88，必被误判成重复、
 * 一路重试到 502。实测（`.tmp/probe-sim.mjs`）：
 *
 *   同文件、不同标识符（不重复）→ 0.30 / 0.50 / 0.67
 *   同标识符、换个说法（重复）  → 1.00
 *
 * 换成「只比标识符 + Jaccard」，两类之间留出干净的空隙，0.8 落在中间。
 */
const DUP_THRESHOLD = 0.8;
/**
 * 没有标识符可依时（纯中文的网页内容）退回整句口径。
 * 这种场景下句式模板带来的虚高没那么严重，阈值相应放宽到 0.6。
 */
const DUP_THRESHOLD_TEXT = 0.6;

/** 出题返回给前端的东西（正确答案不进这里） */
export interface GeneratedQuestion {
  id: string;
  type: 'choice' | 'short';
  prompt: string;
  /** 仅选择题 */
  options?: string[];
  /** 出题依据的资料块标签 */
  sources: string[];
}

export interface GenerateQuestionParams {
  ctx: StoredContext;
  mode: 'choice' | 'short';
  askedQuestions: string[];
  /** 第几次尝试（0 起）。决定采样起点与温度，也决定还卡不卡锚定 */
  attempt: number;
  override?: LlmOverride;
  trace?: TraceSink;
}

/**
 * 出一次题。不合规（重复 / 没锚定 / JSON 坏了）一律抛 `ApiError(502)`，
 * 由调用方决定是重出还是直接失败。
 */
export async function generateQuestionAttempt(
  params: GenerateQuestionParams,
): Promise<GeneratedQuestion> {
  const { ctx, mode, askedQuestions, attempt, override, trace } = params;
  const questionId = newQuestionId();

  if (attempt > 0) {
    emitTrace(
      trace,
      '出题',
      `第 ${attempt + 1} 次尝试：上一版不合格，正在换一批资料、换一个知识点重出。`,
    );
  }

  // 重试时换一批采样块，绕开刚出过题的那段资料
  const bundle = await contextForQuestion(ctx, askedQuestions.length + attempt * 3, override, trace);

  const opts = {
    askedQuestions,
    focus: bundle.focus.map((f) => f.prompt),
    sources: bundle.sources,
    extraHint:
      attempt === 0
        ? undefined
        : '刚才那一版不合格（重复、或没有引用资料里的具体文件/函数名）。请换一个知识点或换一个角度，并确保题干里出现资料中的具体名称。',
  };

  emitTrace(
    trace,
    '出题',
    `正在让模型按资料出题（题型：${mode === 'choice' ? '选择题' : '简答题'}，温度 ${
      attempt === 0 ? 0.9 : 1.0
    }，第 ${attempt + 1} 版）。`,
  );

  const messages =
    mode === 'choice'
      ? choiceQuestionMessages(ctx, bundle.text, opts)
      : shortQuestionMessages(ctx, bundle.text, opts);

  const raw = await chat(messages, {
    temperature: attempt === 0 ? 0.9 : 1.0,
    // 出题要求模型输出结构化 JSON，必须给推理模型留够推理预算 ——
    // 预算不够时正文会被截成半截 JSON，前端看到的就是「没有返回合法的 JSON」。
    maxTokens: limits.llmMaxTokens,
    override,
  });

  const q = mode === 'choice' ? parseChoiceDraft(raw) : parseShortDraft(raw);
  emitTrace(trace, '出题', `模型已出稿：${shortenLabel(q.prompt, 70)}`);

  if (askedQuestions.some((prev) => isDuplicate(prev, q.prompt))) {
    emitTrace(
      trace,
      '出题',
      `自检未通过：与之前出过的题考的是同一个知识点（${shortenLabel(q.prompt, 46)}）。`,
    );
    throw new ApiError(502, '模型重复出题');
  }

  // 最后一次尝试不再卡锚定，避免因为过度严格而整个请求失败
  const lastChance = attempt >= MAX_QUESTION_ATTEMPTS - 1;
  if (!lastChance && !hasConcreteAnchor(q.prompt, bundle)) {
    emitTrace(
      trace,
      '出题',
      '自检未通过：题干没有锚定到资料里的具体文件 / 函数名，属于可套在任何项目上的八股题。',
    );
    throw new ApiError(502, '题目没有锚定到资料中的具体位置');
  }

  if (!lastChance) {
    emitTrace(trace, '出题', '自检通过：题干锚定了资料中的具体名称，与历史题目也不重复。');
  } else {
    emitTrace(trace, '出题', `已到第 ${MAX_QUESTION_ATTEMPTS} 版，放宽锚定要求以免整轮失败。`);
  }

  if (mode === 'choice') {
    const c = q as { prompt: string; options: string[]; correctIndex: number; explanation: string };
    saveAnswerKey(ctx.id, questionId, {
      prompt: c.prompt,
      options: c.options,
      correctIndex: c.correctIndex,
      explanation: c.explanation,
      sourceLabels: bundle.sources,
    });
    emitTrace(trace, '出题', '题目已生成，正确答案已锁在服务端（前端拿不到，无法作弊）。');
    return {
      id: questionId,
      type: 'choice',
      prompt: c.prompt,
      options: c.options,
      sources: bundle.sources,
    };
  }

  const s = q as { prompt: string; reference: string };
  saveAnswerKey(ctx.id, questionId, {
    prompt: s.prompt,
    reference: s.reference,
    sourceLabels: bundle.sources,
  });
  emitTrace(trace, '出题', '题目已生成，参考答案已锁在服务端（前端拿不到，无法作弊）。');
  return { id: questionId, type: 'short', prompt: s.prompt, sources: bundle.sources };
}

/* ------------------------------------------------------------------ */
/* 判重与校验                                                          */
/* ------------------------------------------------------------------ */

/**
 * 两道题是否在考同一个知识点。
 *
 * 优先只比标识符 —— 题干里的文件名/函数名才是知识点，
 * 「在 … 中，… 的主要职责是什么」这层壳是共享模板，比它没有信息量。
 * 双方都拿不出标识符（纯中文网页内容）时才退回整句口径。
 */
function isDuplicate(a: string, b: string): boolean {
  const ia = tokenizeIdentifiers(a);
  const ib = tokenizeIdentifiers(b);
  if (ia.length >= 2 && ib.length >= 2) return jaccard(ia, ib) >= DUP_THRESHOLD;
  return jaccard(tokenize(a), tokenize(b)) >= DUP_THRESHOLD_TEXT;
}

/**
 * Jaccard：交集 / 并集，取值 0~1。
 * 刻意不用「交集 / 较短一方」—— 后者对长度差异不敏感，
 * 一道短题会被一道长题完全包含而算出 1.0，属于虚高。
 */
function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hits = 0;
  for (const t of A) if (B.has(t)) hits += 1;
  return hits / (A.size + B.size - hits);
}

/**
 * 检查题干是否锚定到了资料里的具体名称。
 *
 * 这是对「八股式提问」的硬约束：光在提示词里说「要引用文件名」模型经常不听，
 * 所以在服务端也验一遍 —— 题干里至少得有一个词，是本次资料里真实出现过的标识符
 * （文件名、函数名、配置项等）。
 */
function hasConcreteAnchor(prompt: string, bundle: { sources: string[]; text: string }): boolean {
  const haystack = `${bundle.sources.join('\n')}\n${bundle.text}`.toLowerCase();
  const candidates = prompt.match(/[A-Za-z][A-Za-z0-9_$.-]{2,}/g) ?? [];

  for (const raw of candidates) {
    const token = raw.toLowerCase().replace(/[.,]+$/, '');
    if (token.length < 3) continue;
    // 形如 `Axios.js` / `lib/core` 的写法本身就说明在指位置
    if (/[./]/.test(token)) return true;
    if (haystack.includes(token)) return true;
  }
  return false;
}

function asText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseChoiceDraft(raw: string) {
  const draft = extractJson<{
    prompt?: unknown;
    options?: unknown;
    correctIndex?: unknown;
    explanation?: unknown;
  }>(raw, '选择题');
  const prompt = asText(draft.prompt, 300);
  const options = Array.isArray(draft.options)
    ? draft.options.map((o) => asText(o, 200)).filter(Boolean)
    : [];
  const correctIndex = Number(draft.correctIndex);

  if (!prompt) throw new ApiError(502, '模型出的选择题缺少题干');
  if (options.length < 2) throw new ApiError(502, '模型出的选择题选项不足');
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
    throw new ApiError(502, '模型给出的正确答案下标越界');
  }

  return { prompt, options, correctIndex, explanation: asText(draft.explanation, 600) };
}

function parseShortDraft(raw: string) {
  const draft = extractJson<{ prompt?: unknown; reference?: unknown }>(raw, '简答题');
  const prompt = asText(draft.prompt, 200);
  const reference = asText(draft.reference, 800);

  if (!prompt) throw new ApiError(502, '模型出的简答题缺少题干');
  if (!reference) throw new ApiError(502, '模型没有给出参考答案');

  return { prompt, reference };
}

/**
 * 自检类失败才值得重出；会话失效、网关故障重试没有意义。
 *
 * 「没有返回合法的 JSON」也算 —— 模型偶尔会漏个括号、或把解析写在 JSON 之外。
 * 换一批资料、换一个知识点重出一次，往往就正常了；
 * 不把它算进来的话，一次输出抖动就会把整轮出题判死（用户只能手动再点一次）。
 */
export function isQuestionRetryable(err: ApiError): boolean {
  return /重复出题|没有锚定|缺少题干|选项不足|下标越界|参考答案|没有返回合法的 JSON/.test(
    err.message,
  );
}
