import { readLlmOverride } from '@/server/byok';
import { ApiError, describeUpstream, readJson, requireString, toErrorResponse } from '@/server/http';
import { chat, chatStream, extractJson } from '@/server/llm';
import { askMessages, gradeShortMessages, hintMessages, summarizeHistory } from '@/server/prompts';
import { generateQuestionAttempt, isQuestionRetryable, MAX_QUESTION_ATTEMPTS } from '@/server/question';
import { contextForAsk, memoryDigest } from '@/server/rag';
import {
  getAnswerKey,
  MAX_SHORT_SCORE,
  recordInteraction,
  recordUserQuery,
  requireContext,
  verdictForScore,
} from '@/server/store';
import { emitTrace, scoreLabel, type TraceSink } from '@/server/trace';
import type { LlmOverride } from '@/server/config';
import { limits } from '@/server/config';

export const runtime = 'nodejs';
export const maxDuration = 120;

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
          { temperature: 0.3, maxTokens: limits.llmMaxTokens, override },
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
          // 提示正文很短，但推理模型的推理过程同样计入预算，给 700 会稳定截断
          { temperature: 0.5, maxTokens: limits.llmMaxTokens, override },
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
            maxTokens: limits.llmMaxTokens,
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

        /*
         * 出题的全部逻辑（解析模型输出、判重、锚定校验、写答案键）在
         * `src/server/question.ts` 里，与一次性路由 `/api/agent/question` 共用一份。
         * 两条路由各写一份的代价已经付过：流式这边把判重口径修好了，
         * 一次性那边还留着旧的整句口径，于是回归里「修好了」和「没修好」同时成立。
         */
        const result = await generateQuestionAttempt({
          ctx,
          mode,
          askedQuestions,
          attempt,
          override,
          trace,
        });
        send({ type: 'result', result });
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
/* 本端点自用的零碎辅助                                                */
/*                                                                     */
/* 出题的解析 / 判重 / 锚定校验全部在 `src/server/question.ts`，        */
/* 这里**不再留副本** —— 两份实现必然分叉，上一次就是这么坏的。         */
/* ------------------------------------------------------------------ */

const LETTERS = 'ABCDEFGH';

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
