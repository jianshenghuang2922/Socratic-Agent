import { NextResponse } from 'next/server';
import { limits } from '@/server/config';
import { readLlmOverride } from '@/server/byok';
import { ApiError, readJson, requireString } from '@/server/http';
import { claimTrial, toErrorResponseWithTrial, type TrialClaim } from '@/server/trial';
import { chat, extractJson } from '@/server/llm';
import { gradeShortMessages } from '@/server/prompts';
import { contextForAsk } from '@/server/rag';
import {
  getAnswerKey,
  MAX_SHORT_SCORE,
  recordInteraction,
  requireContext,
  verdictForScore,
} from '@/server/store';

export const runtime = 'nodejs';
export const maxDuration = 120;

interface GradeBody {
  contextId?: string;
  type?: string;
  /** 题目 id：出题接口返回的 id */
  questionId?: string;
  /** 前端也可以直接把整道题回传，从 question.id 里取 */
  question?: { id?: string; prompt?: string };
  selectedIndex?: number;
  answer?: string;
}

interface GradeDraft {
  score?: unknown;
  feedback?: unknown;
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

const LETTERS = 'ABCDEFGH';

/**
 * POST /api/agent/grade
 * body: { contextId, type, questionId, selectedIndex }   —— 选择题
 *       { contextId, type, questionId, question, answer } —— 简答题
 *
 * 选择题不调模型：直接比对服务端留存的答案键，零成本、零延迟、判定确定。
 * 简答题必须调模型：参考答案只存在服务端，模型按采分点覆盖度打 0 ~ 5 分并给出点评。
 *
 * 判分完成后，这次作答会作为「用户回复」写进会话记忆并进入检索索引 ——
 * 后续出题会针对答错的知识点换角度再问。
 */
export async function POST(req: Request) {
  let claim: TrialClaim | null = null;
  try {
    const override = readLlmOverride(req);
    const body = await readJson<GradeBody>(req);
    const ctx = requireContext(body.contextId);

    const questionId = body.questionId ?? body.question?.id;
    if (!questionId) throw new ApiError(400, '缺少必填字段：questionId');

    const key = getAnswerKey(ctx.id, questionId);
    if (!key) throw new ApiError(410, '题目答案已失效，请重新出题');

    /* ---------------- 简答题：交给模型按采分点打分 ---------------- */
    if (body.type === 'short') {
      const prompt = requireString(body.question?.prompt ?? key.prompt, 'question.prompt', 1000);
      const answer = requireString(body.answer, 'answer', 4000);
      const reference = key.reference?.trim();
      if (!reference) throw new ApiError(410, '题目答案已失效，请重新出题');

      /*
       * 只有简答题占额度 —— 选择题判分是纯服务端比对，不调模型。
       * 占位放在 contextForAsk 之前：检索里的查询扩展本身就会调一次模型。
       */
      claim = claimTrial(req, override);

      // 只喂与题目相关的资料片段，供模型核对要点
      const bundle = await contextForAsk(ctx, prompt, [], override);

      const raw = await chat(gradeShortMessages(ctx, prompt, reference, answer, bundle.text), {
        temperature: 0.2,
        maxTokens: limits.llmMaxTokens,
        override,
      });

      const draft = extractJson<GradeDraft>(raw, '简答题判分');
      const score = parseScore(draft.score);
      const verdict = verdictForScore(score);
      const feedback =
        typeof draft.feedback === 'string' && draft.feedback.trim()
          ? draft.feedback.trim().slice(0, 600)
          : '已收到你的作答。';

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

      return NextResponse.json({ score, feedback, reference });
    }

    /* ---------------- 选择题：纯服务端比对 ---------------- */
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

    const correct = selectedIndex === key.correctIndex;

    if (key.prompt) {
      const options = key.options ?? [];
      const pick = options[selectedIndex];
      recordInteraction(ctx.id, {
        questionId,
        prompt: key.prompt,
        userAnswer: pick ? `${LETTERS[selectedIndex] ?? selectedIndex + 1}. ${pick}` : `选项 ${selectedIndex + 1}`,
        correct,
        verdict: correct ? 'correct' : 'incorrect',
        sourceLabels: key.sourceLabels ?? [],
        knowledge: key.explanation ?? '',
      });
    }

    return NextResponse.json({
      correct,
      correctIndex: key.correctIndex,
      explanation: key.explanation ?? '',
    });
  } catch (err) {
    // 简答题判分失败才需要退；选择题那条路 claim 恒为 null，这里天然是空操作
    claim?.refund();
    return toErrorResponseWithTrial(err, req);
  }
}
