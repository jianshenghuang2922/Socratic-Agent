import { NextResponse } from 'next/server';
import { limits } from '@/server/config';
import { readLlmOverride } from '@/server/byok';
import { ApiError, readJson } from '@/server/http';
import { claimTrial, toErrorResponseWithTrial, type TrialClaim } from '@/server/trial';
import { chat } from '@/server/llm';
import { hintMessages } from '@/server/prompts';
import { contextForAsk } from '@/server/rag';
import { getAnswerKey, requireContext } from '@/server/store';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** 提示正文长度上限 —— 防止模型写成一篇小作文，把答案顺带讲透 */
const MAX_HINT_CHARS = 400;

interface HintBody {
  contextId?: string;
  type?: string;
  /** 题目 id：出题接口返回的 id */
  questionId?: string;
  /** 前端也可以直接把整道题回传，从 question.id 里取 */
  question?: { id?: string; prompt?: string };
}

/**
 * POST /api/agent/hint
 * body: { contextId, type, questionId, question?: { id, prompt } }
 *   -> { hint }
 *
 * 回答模式的「给点提示」：学生卡住时给一个启发式引导。
 *
 * 与 /grade 的本质区别：
 *  - 不判分、不计分、不写用户记忆（他还没作答，写进去只会污染薄弱点统计）；
 *  - 正确答案仍留在服务端，只作为「内部信息」喂给模型判断引导方向，绝不下发；
 *  - 返回的是纯文本引导，不是结构化判分结果。
 */
export async function POST(req: Request) {
  let claim: TrialClaim | null = null;
  try {
    const override = readLlmOverride(req);
    const body = await readJson<HintBody>(req);
    const ctx = requireContext(body.contextId);

    const questionId = body.questionId ?? body.question?.id;
    if (!questionId) throw new ApiError(400, '缺少必填字段：questionId');

    const key = getAnswerKey(ctx.id, questionId);
    if (!key) throw new ApiError(410, '题目答案已失效，请重新出题');

    const type: 'choice' | 'short' = body.type === 'short' ? 'short' : 'choice';
    const prompt = (body.question?.prompt ?? key.prompt ?? '').trim();
    if (!prompt) throw new ApiError(410, '题目答案已失效，请重新出题');

    // 模型得知道「正确方向」才引导得到位；缺失说明答案键不完整，重新出题
    if (type === 'choice') {
      if (typeof key.correctIndex !== 'number' || !key.options?.length) {
        throw new ApiError(410, '题目答案已失效，请重新出题');
      }
    } else if (!key.reference?.trim()) {
      throw new ApiError(410, '题目答案已失效，请重新出题');
    }

    /*
     * 占额度必须在 contextForAsk **之前** —— 检索里的查询扩展本身就会调一次模型，
     * 放到后面等于「扩展烧了上游额度却不计数」。
     * 题目与答案键都校验通过才走到这里，畸形请求不会消耗用户次数。
     */
    claim = claimTrial(req, override);

    // 只喂与题目相关的资料片段，提示才能落到具体名称上
    const bundle = await contextForAsk(ctx, prompt, [], override);

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

    return NextResponse.json({ hint });
  } catch (err) {
    // 没给出提示，额度退回去
    claim?.refund();
    return toErrorResponseWithTrial(err, req);
  }
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
