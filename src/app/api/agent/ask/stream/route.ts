import { readLlmOverride } from '@/server/byok';
import { ApiError, describeUpstream, readJson, requireString, toErrorResponse } from '@/server/http';
import { chat, chatStream, extractJson } from '@/server/llm';
import {
  askMessages,
  choiceQuestionMessages,
  gradeShortMessages,
  hintMessages,
  shortQuestionMessages,
  summarizeHistory,
} from '@/server/prompts';
import { contextForAsk, contextForQuestion, memoryDigest } from '@/server/rag';
import { tokenize, tokenizeIdentifiers } from '@/server/retrieve';
import {
  getAnswerKey,
  MAX_SHORT_SCORE,
  newQuestionId,
  recordInteraction,
  recordUserQuery,
  requireContext,
  saveAnswerKey,
  verdictForScore,
} from '@/server/store';
import { emitTrace, scoreLabel, shortenLabel, type TraceSink } from '@/server/trace';
import type { LlmOverride } from '@/server/config';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** 出题最多重出几次（重试由前端逐次驱动，见下方说明） */
const MAX_QUESTION_ATTEMPTS = 3;
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
/** 提示正文长度上限 —— 防止模型写成一篇小作文，把答案顺带讲透 */
const MAX_HINT_CHARS = 400;

/**
 * POST /api/agent/ask/stream
 * body: { contextId, question, history }                                提问模式
 *     | { contextId, mode: 'choice' | 'short', history }                回答模式·出题
 *     | { contextId, action: 'question', ..., attempt }                 回答模式·出题（带重试轮次）
 *     | { contextId, action: 'hint', type, questionId, question }       回答模式·给点提示
 *     | { contextId, action: 'grade', type, questionId, ... }           回答模式·判分
 *
 * 一个 SSE 端点承载所有 Agent 动作，理由不只是省代码：
 * 用户等待时最想看的是**思考过程**，而思考只存在于生成过程中。
 * 一次性 JSON 接口没法边算边说，只有流式才能把中间步骤实时讲出来。
 * 所以把出题、判分、提示也搬到流式上，它们的中间步骤（检索、锚定校验、重试）
 * 同样有信息量。
 *
 * 事件协议（`data:` 行内是 JSON）：
 *   { "type": "trace",   "stage": "检索", "detail": "…" }  思考过程，一条一句话
 *   { "type": "status",  "text": "…" }                     粗粒度状态（兼容旧前端）
 *   { "type": "sources", "sources": [...] }                提问模式：本次依据的资料
 *   { "type": "delta",   "text": "…" }                     提问模式：增量正文
 *   { "type": "result",  "result": {...} }                 出题/判分/提示：结构化结果
 *   { "type": "done" }                                     正常结束
 *   { "type": "error",   "error": "中文提示", "retryable": true }  出错
 *
 * 错误为什么走事件而不是状态码：一旦开始吐字，响应头已经发出去了，
 * 这时改不了状态码。统一用 `error` 事件让前端有唯一处理路径。
 */
export async function POST(req: Request) {
  let ctx: ReturnType<typeof requireContext>;
  let body: Record<string, unknown>;
  let override: LlmOverride | undefined;

  // 参数校验放在建立流之前 —— 这些错误还能用正常状态码返回
  try {
    override = readLlmOverride(req);
    body = await readJson<Record<string, unknown>>(req);
    // body.contextId 是 unknown：readJson 是泛型断言，不做运行时校验，
    // 必须自己收窄再递给 requireContext（它对 null 会给出 410）
    ctx = requireContext(typeof body.contextId === 'string' ? body.contextId : undefined);
  } catch (err) {
    return toErrorResponse(err);
  }

  const action = typeof body.action === 'string' ? body.action : null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // 客户端已断开，后续 enqueue 都会抛；静默忽略即可
          closed = true;
        }
      };

      const trace: TraceSink = (event) => send({ type: 'trace', ...event });

      try {
        if (action === 'question') await runQuestion();
        else if (action === 'hint') await runHint();
        else if (action === 'grade') await runGrade();
        else await runAsk();

        send({ type: 'done' });
      } catch (err) {
        console.error('[ask/stream] 失败:', err);
        // 走流式时就改不了状态码了，只能把错误当事件发；同样要归一化成中文
        // retryable：出题被判定「重复 / 不够具体」时前端可以换一批资料重试，
        // 其他错误（会话失效、网关故障）重试没有意义
        const retryable = err instanceof ApiError && err.status === 502 && isQuestionRetryable(err);
        send({ type: 'error', error: describeUpstream(err), retryable });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* 已经关了 */
        }
      }

      /* ---------------- 提问模式 ---------------- */

      async function runAsk() {
        const question = requireString(body.question, 'question', 4000);
        const { recentTurns, recentUserTurns } = summarizeHistory(body.history);

        const bundle = await contextForAsk(ctx, question, recentUserTurns, override, trace);
        send({ type: 'sources', sources: bundle.sources });

        emitTrace(trace, '生成', '资料已就位，开始逐字作答…');
        await chatStream(
          askMessages(ctx, question, bundle.text, recentTurns, memoryDigest(ctx, 8, trace)),
          (delta) => send({ type: 'delta', text: delta }),
          { temperature: 0.3, maxTokens: 2500, override },
        );

        // 用户的问题本身也是「用户回复」，记下来并进索引
        recordUserQuery(ctx.id, question);
        emitTrace(trace, '生成', '回答完成。');
      }

      /* ---------------- 回答模式：给点提示 ---------------- */

      async function runHint() {
        const questionId = asString(body.questionId) ?? asString(asRecord(body.question)?.id);
        if (!questionId) throw new ApiError(400, '缺少必填字段：questionId');

        emitTrace(trace, '提示', '正在取回这道题的答案要点，用来判断引导方向（不会直接告诉你答案）。');
        const key = getAnswerKey(ctx.id, questionId);
        if (!key) throw new ApiError(410, '题目答案已失效，请重新出题');

        const type: 'choice' | 'short' = body.type === 'short' ? 'short' : 'choice';
        const prompt = (asString(asRecord(body.question)?.prompt) ?? key.prompt ?? '').trim();
        if (!prompt) throw new ApiError(410, '题目答案已失效，请重新出题');

        // 模型得知道「正确方向」才引导得到位；缺失说明答案键不完整，重新出题
        if (type === 'choice') {
          if (typeof key.correctIndex !== 'number' || !key.options?.length) {
            throw new ApiError(410, '题目答案已失效，请重新出题');
          }
        } else if (!key.reference?.trim()) {
          throw new ApiError(410, '题目答案已失效，请重新出题');
        }

        // 只喂与题目相关的资料片段，提示才能落到具体名称上
        const bundle = await contextForAsk(ctx, prompt, [], override, trace);

        emitTrace(trace, '提示', '正在生成引导：只指思路方向，划死线不给答案、不排除到只剩一个。');
        const raw = await chat(
          hintMessages(
            ctx,
            {
              type,
              prompt,
              options: key.options,
              correctIndex: key.correctIndex,
              explanation: key.explanation,
              reference: key.reference,
            },
            bundle.text,
          ),
          { temperature: 0.5, maxTokens: 700, override },
        );

        const hint = cleanHint(raw);
        if (!hint) throw new ApiError(502, '模型没有给出有效提示，请重试');

        emitTrace(trace, '提示', '引导已就绪（仅启发思路，作答状态与计分不受影响）。');
        send({ type: 'result', result: { hint } });
      }

      /* ---------------- 回答模式：判分 ---------------- */

      async function runGrade() {
        const questionId = asString(body.questionId) ?? asString(asRecord(body.question)?.id);
        if (!questionId) throw new ApiError(400, '缺少必填字段：questionId');

        const key = getAnswerKey(ctx.id, questionId);
        if (!key) throw new ApiError(410, '题目答案已失效，请重新出题');

        /* ---- 简答题：交给模型按采分点打分 ---- */
        if (body.type === 'short') {
          const prompt = requireString(
            asString(asRecord(body.question)?.prompt) ?? key.prompt,
            'question.prompt',
            1000,
          );
          const answer = requireString(body.answer, 'answer', 4000);
          const reference = key.reference?.trim();
          if (!reference) throw new ApiError(410, '题目答案已失效，请重新出题');

          emitTrace(trace, '判分', '正在按参考答案拆解采分点，再逐条核对你答到了哪些。');

          // 只喂与题目相关的资料片段，供模型核对要点
          const bundle = await contextForAsk(ctx, prompt, [], override, trace);

          const raw = await chat(gradeShortMessages(ctx, prompt, reference, answer, bundle.text), {
            temperature: 0.2,
            maxTokens: 2500,
            override,
          });

          const draft = extractJson<{ score?: unknown; feedback?: unknown }>(raw, '简答题判分');
          const score = parseScore(draft.score);
          const verdict = verdictForScore(score);
          const feedback =
            typeof draft.feedback === 'string' && draft.feedback.trim()
              ? draft.feedback.trim().slice(0, 600)
              : '已收到你的作答。';

          emitTrace(
            trace,
            '判分',
            `采分点覆盖度核算完毕：得 ${score} / ${MAX_SHORT_SCORE} 分（${verdictLabel(score)}）。`,
          );
          emitTrace(trace, '判分', '这次作答已记入你的学习档案，后续出题会针对薄弱点换角度再问。');

          recordInteraction(ctx.id, {
            questionId,
            prompt,
            userAnswer: answer,
            correct: verdict === 'correct',
            verdict,
            score,
            sourceLabels: key.sourceLabels ?? [],
            knowledge: [reference, feedback].filter(Boolean).join('\n'),
          });

          send({ type: 'result', result: { score, feedback, reference } });
          return;
        }

        /* ---- 选择题：纯服务端比对，不调模型 ---- */
        if (typeof key.correctIndex !== 'number') {
          throw new ApiError(410, '题目答案已失效，请重新出题');
        }

        /*
         * 必须收严：`Number(body.selectedIndex)` 对 undefined 是 NaN（会被下面拦住），
         * 但对 null / '' / '  ' 一律得到 0 —— 一个畸形请求会被静默判成「选了 A」，
         * 既给出错误结果，又把错误的作答记录写进会话记忆。
         */
        const selectedIndex = body.selectedIndex;
        if (typeof selectedIndex !== 'number' || !Number.isInteger(selectedIndex)) {
          throw new ApiError(400, '缺少必填字段：selectedIndex');
        }
        // 越界的下标不报错的话，只会静默判成「错」，还会把记录写歪
        const optionCount = key.options?.length ?? 0;
        if (selectedIndex < 0 || (optionCount > 0 && selectedIndex >= optionCount)) {
          throw new ApiError(400, `selectedIndex 超出选项范围（0 ~ ${optionCount - 1}）`);
        }

        emitTrace(trace, '判分', '选择题由服务端直接比对答案，无需调用模型（零延迟、判定确定）。');
        const correct = selectedIndex === key.correctIndex;

        if (key.prompt) {
          const options = key.options ?? [];
          const pick = options[selectedIndex];
          recordInteraction(ctx.id, {
            questionId,
            prompt: key.prompt,
            userAnswer: pick
              ? `${LETTERS[selectedIndex] ?? selectedIndex + 1}. ${pick}`
              : `选项 ${selectedIndex + 1}`,
            correct,
            verdict: correct ? 'correct' : 'incorrect',
            sourceLabels: key.sourceLabels ?? [],
            knowledge: key.explanation ?? '',
          });
        }

        emitTrace(
          trace,
          '判分',
          correct
            ? `比对你的选择与答案键：一致，判定为正确。`
            : `比对你的选择与答案键：不一致，判定为错误，正确答案是 ${LETTERS[key.correctIndex] ?? key.correctIndex + 1}。`,
        );

        send({
          type: 'result',
          result: {
            correct,
            correctIndex: key.correctIndex,
            explanation: key.explanation ?? '',
          },
        });
      }

      /* ---------------- 回答模式：出题 ---------------- */

      /**
       * 只跑**一次**尝试。
       *
       * 原实现里重出循环在服务端（最多 3 次，中间无任何反馈）——
       * 用户面前是一个静默转圈几十秒的黑盒，运气差时一次要等三轮模型调用。
       * 现在把重试交给前端逐次驱动：每轮都先把「为什么重出」讲清楚，
       * 等待被拆成看得懂的段落，用户也随时能停。
       */
      async function runQuestion() {
        const mode = body.mode === 'short' ? 'short' : 'choice';
        const attempt = clampAttempt(body.attempt);
        const { askedQuestions } = summarizeHistory(body.history);
        const questionId = newQuestionId();

        if (attempt > 0) {
          emitTrace(
            trace,
            '出题',
            `第 ${attempt + 1} 次尝试：上一版不合格，正在换一批资料、换一个知识点重出。`,
          );
        }

        // 重试时换一批采样块，绕开刚出过题的那段资料
        const bundle = await contextForQuestion(
          ctx,
          askedQuestions.length + attempt * 3,
          override,
          trace,
        );

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
          maxTokens: 2500,
          override,
        });

        const q = mode === 'choice' ? parseChoiceDraft(raw) : parseShortDraft(raw);
        emitTrace(trace, '出题', `模型已出稿：${shortenLabel(q.prompt, 70)}`);

        if (askedQuestions.some((prev) => isDuplicate(prev, q.prompt))) {
          emitTrace(trace, '出题', '自检未通过：与之前出过的题考的是同一个知识点。');
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
          emitTrace(trace, '出题', `题目已生成，正确答案已锁在服务端（前端拿不到，无法作弊）。`);
          send({
            type: 'result',
            result: {
              id: questionId,
              type: 'choice',
              prompt: c.prompt,
              options: c.options,
              sources: bundle.sources,
            },
          });
          return;
        }

        const s = q as { prompt: string; reference: string };
        saveAnswerKey(ctx.id, questionId, {
          prompt: s.prompt,
          reference: s.reference,
          sourceLabels: bundle.sources,
        });
        emitTrace(trace, '出题', `题目已生成，参考答案已锁在服务端（前端拿不到，无法作弊）。`);
        send({
          type: 'result',
          result: { id: questionId, type: 'short', prompt: s.prompt, sources: bundle.sources },
        });
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // 必须禁掉缓冲，否则中间层会把整个流攒完再吐
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/* ------------------------------------------------------------------ */
/* 出题辅助（原 question/route.ts，随重试下放一并搬来）                 */
/* ------------------------------------------------------------------ */

const LETTERS = 'ABCDEFGH';

/** 自检类失败才值得重出；会话失效、网关故障重试没有意义 */
function isQuestionRetryable(err: ApiError): boolean {
  return /重复出题|没有锚定|缺少题干|选项不足|下标越界|参考答案/.test(err.message);
}

function clampAttempt(value: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_QUESTION_ATTEMPTS - 1);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

function asText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

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
function hasConcreteAnchor(
  prompt: string,
  bundle: { sources: string[]; text: string },
): boolean {
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
 * 把模型给的分数收严成 0 ~ 5 的整数。
 * 模型偶尔会把 score 写成字符串（"4"）或越界（7 / -1），
 * 越界就夹到边界，完全拿不到数字才当输出不合规上抛。
 */
function parseScore(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(n)) throw new ApiError(502, '模型没有给出有效分数');
  return Math.min(MAX_SHORT_SCORE, Math.max(0, Math.round(n)));
}

function verdictLabel(score: number): string {
  if (score >= 5) return '优秀';
  if (score >= 4) return '良好';
  if (score >= 3) return '及格';
  if (score >= 2) return '待加强';
  if (score >= 1) return '薄弱';
  return '未掌握';
}

/** 去掉可能的代码围栏与包裹引号，并截断到上限 */
function cleanHint(raw: string): string {
  return raw
    .replace(/^\s*```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
    .replace(/^["「『]+|["」』]+$/g, '')
    .trim()
    .slice(0, MAX_HINT_CHARS);
}
