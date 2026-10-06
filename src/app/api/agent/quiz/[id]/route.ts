import { NextResponse } from 'next/server';
import { ApiError, readJson, requireString, toErrorResponse } from '@/server/http';
import { countPlayer, gradeQuizAnswer, requireQuiz, toQuizView } from '@/server/quiz';

export const runtime = 'nodejs';

/** Next 15 起动态段的 params 是 Promise，必须 await */
type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/agent/quiz/[id]
 *
 * 取整套题目。**不含答案键** —— 与主流程「答案绝不下发」是同一口径。
 * 前端做题时每题单独 POST 判分，答案在那一刻才由服务端比对。
 *
 * 这个端点是公开的（链接本身就是凭证），没有会话、不需要任何凭据。
 */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    return NextResponse.json(toQuizView(requireQuiz(id)));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/agent/quiz/[id]
 * body: { questionId, selectedIndex, player? } -> { correct, correctIndex, explanation }
 *
 * 判一道题。纯服务端整数比对：不调模型、不占额度、不写任何用户记忆。
 * 一次只判一道，是为了让做题的人**立刻**知道对错 —— 攒到最后一起判，
 * 体验上就退化成了一张试卷，也就没人愿意往下做了。
 *
 * `player` 是浏览器本地生成的匿名 id，只用来把「同一个人刷新十次」算成一个人。
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const quiz = requireQuiz(id);

    const body = await readJson<{ questionId?: string; selectedIndex?: number; player?: string }>(req);
    const questionId = requireString(body.questionId, 'questionId', 200);

    /*
     * 必须收严成整数：`Number(null)` / `Number('')` 都是 0，
     * 一个畸形请求会被静默判成「选了 A」并给出一个看似正常的错判结果。
     */
    const selectedIndex = body.selectedIndex;
    if (typeof selectedIndex !== 'number' || !Number.isInteger(selectedIndex)) {
      throw new ApiError(400, '缺少必填字段：selectedIndex');
    }

    const grade = gradeQuizAnswer(quiz, questionId, selectedIndex);
    countPlayer(quiz, typeof body.player === 'string' ? body.player.slice(0, 64) : undefined);
    return NextResponse.json(grade);
  } catch (err) {
    return toErrorResponse(err);
  }
}
