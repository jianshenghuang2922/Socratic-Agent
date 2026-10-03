import { NextResponse } from 'next/server';
import { readLlmOverride } from '@/server/byok';
import { readJson, requireString, toErrorResponse } from '@/server/http';
import { chat } from '@/server/llm';
import { askMessages, summarizeHistory } from '@/server/prompts';
import { contextForAsk, memoryDigest } from '@/server/rag';
import { recordUserQuery, requireContext } from '@/server/store';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/agent/ask
 * body: { contextId, question, history }
 *
 * 提问模式：RAG 检索后作答。
 * 检索范围同时覆盖「项目内容」与「用户回复」（历史作答 + 提过的问题），
 * 所以用户可以直接问「我刚才答错的那题考的是什么」。
 *
 * 凭据：默认用服务端的；请求头带了 x-llm-* 就用用户自带的（BYOK）。
 */
export async function POST(req: Request) {
  try {
    const override = readLlmOverride(req);
    const body = await readJson<{ contextId?: string; question?: string; history?: unknown }>(req);
    const question = requireString(body.question, 'question', 4000);
    const ctx = requireContext(body.contextId);

    const { recentTurns, recentUserTurns } = summarizeHistory(body.history);

    const bundle = await contextForAsk(ctx, question, recentUserTurns, override);

    const answer = await chat(
      askMessages(ctx, question, bundle.text, recentTurns, memoryDigest(ctx)),
      { temperature: 0.3, maxTokens: 2500, override },
    );

    // 用户的问题本身也是「用户回复」，记下来并进索引
    recordUserQuery(ctx.id, question);

    return NextResponse.json({
      answer,
      /** 本次回答依据了哪些内容，前端可选展示 */
      sources: bundle.sources,
      /** 中文提问被映射到哪些项目标识符，便于排查检索效果 */
      expanded: bundle.expanded ?? [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
