import { NextResponse } from 'next/server';
import { readJson, toErrorResponse } from '@/server/http';
import { publishQuiz, toQuizView } from '@/server/quiz';
import { requireContext } from '@/server/store';
import type { SharedQuizLink } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * POST /api/agent/quiz
 * body: { contextId } -> { quizId, title, url, count, players }
 *
 * 把这次会话里已生成的选择题打包成一条可分享链接。
 *
 * 刻意**不占免费额度**：这个动作一次模型都不调 ——
 * 题目与答案键在出题时就已经存好了，这里只是换个容器装起来。
 * 把它算成一次额度消耗会让「分享」这件事变得有成本，正好毁掉整个回路的意义。
 *
 * 对同一会话幂等：重复调用返回同一个 quizId（内容会跟上最新进度），
 * 所以前端可以放心地「点一次生成一次」，不必自己缓存链接。
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ contextId?: string }>(req);
    const ctx = requireContext(typeof body.contextId === 'string' ? body.contextId : undefined);

    const view = toQuizView(publishQuiz(ctx));
    const payload: SharedQuizLink = {
      quizId: view.id,
      title: view.title,
      sourceUrl: view.sourceUrl,
      count: view.count,
      players: view.players,
    };
    return NextResponse.json(payload);
  } catch (err) {
    return toErrorResponse(err);
  }
}
