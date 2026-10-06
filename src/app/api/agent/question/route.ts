import { NextResponse } from 'next/server';
import { readLlmOverride } from '@/server/byok';
import { ApiError, readJson } from '@/server/http';
import { claimTrial, toErrorResponseWithTrial, type TrialClaim } from '@/server/trial';
import { summarizeHistory } from '@/server/prompts';
import {
  generateQuestionAttempt,
  isQuestionRetryable,
  MAX_QUESTION_ATTEMPTS,
} from '@/server/question';
import { requireContext } from '@/server/store';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/agent/question
 * body: { contextId, mode: 'choice' | 'short', history }
 *
 * 回答模式：RAG 召回后出题。正确答案只写进服务端会话表，响应里只回题干与选项。
 *
 * 这是**一次性**版本（前端已改走 `/api/agent/ask/stream` 的 `action:'question'`，
 * 那边由前端逐轮驱动重试、能实时吐思考过程）。此路由保留是为了维持对外契约。
 *
 * 出题的全部逻辑（解析模型输出、判重、锚定校验、写答案键）在 `src/server/question.ts`，
 * 与流式端点共用**一份**。这里只负责「失败就重出，最多 MAX_QUESTION_ATTEMPTS 次」。
 *
 * 两条路由曾经各写一份判重，代价很具体：流式那边把口径修成「只比标识符」，
 * 一次性这边还留着旧的「整句词元重合率 ≥ 0.6」，把两道考不同函数（同属一个文件）
 * 的题一律判成重复，连着重试三次后 502。回归脚本打的正是这条路由，
 * 于是「修好了」和「没修好」在回归里同时成立 —— 典型的双实现漂移。
 */
export async function POST(req: Request) {
  let claim: TrialClaim | null = null;
  try {
    const override = readLlmOverride(req);
    const body = await readJson<{ contextId?: string; mode?: string; history?: unknown }>(req);
    // body.contextId 是 unknown：readJson 是泛型断言，不做运行时校验，必须自己收窄
    const ctx = requireContext(typeof body.contextId === 'string' ? body.contextId : undefined);

    const mode = body.mode === 'short' ? 'short' : 'choice';
    const { askedQuestions } = summarizeHistory(body.history);

    /*
     * 额度按「一次出题」计，不按下面的重出轮次计 ——
     * 重出是服务端自检没过（题目重复 / 不够具体），那是我们自己的问题，
     * 让用户为三次重试付三次额度会非常费解。
     */
    claim = claimTrial(req, override);

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_QUESTION_ATTEMPTS; attempt += 1) {
      try {
        return NextResponse.json(
          await generateQuestionAttempt({ ctx, mode, askedQuestions, attempt, override }),
        );
      } catch (err) {
        lastError = err;
        // 只有「模型输出不合规 / 重复 / 不够具体」值得重出；会话过期、网关故障等直接上抛
        if (!(err instanceof ApiError) || err.status !== 502 || !isQuestionRetryable(err)) {
          throw err;
        }
      }
    }

    throw lastError;
  } catch (err) {
    // 全部轮次都没出成题，额度退回去
    claim?.refund();
    return toErrorResponseWithTrial(err, req);
  }
}
