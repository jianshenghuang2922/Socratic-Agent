/**
 * 做题页专用的极简客户端。
 *
 * 为什么不复用 `HttpAgentClient`：那个类的核心职责是**持有会话** ——
 * 它把 contextId 存在实例内部，每个方法都自动带上。
 * 做题页恰恰相反：它是完全无会话的（链接本身就是全部凭证），
 * 套进那个类只会得到一堆用不上、还要小心别触发 `session()` 报错的状态。
 *
 * 这里只有两个动作：取题（服务端渲染时已完成，见 app/quiz/[id]/page.tsx）
 * 与判一道题。判分不调模型、不需要 BYOK 凭据，所以连请求头都不用带。
 */

import type { SharedQuizGrade } from './types';

const PLAYER_KEY = 'socratic.player.v1';

/**
 * 匿名做题者 id。
 *
 * 唯一用途是把「同一个人刷新十次」算成一个人，从而让分享者看到的人数有意义。
 * 不含任何身份信息，也不发给除本服务之外的地方。
 */
export function playerId(): string {
  if (typeof window === 'undefined') return '';
  try {
    const existing = window.localStorage.getItem(PLAYER_KEY);
    if (existing) return existing;
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.localStorage.setItem(PLAYER_KEY, id);
    return id;
  } catch {
    // 隐私模式 / 禁用存储会抛异常 —— 退化成「不参与人数统计」，不影响做题
    return '';
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    if (payload?.error) return payload.error;
  } catch {
    /* 非 JSON 响应 */
  }
  return `${res.status} ${res.statusText}`;
}

/** 判一道题。服务端纯整数比对，零延迟、零成本 */
export async function gradeSharedQuestion(
  quizId: string,
  questionId: string,
  selectedIndex: number,
): Promise<SharedQuizGrade> {
  const res = await fetch(`/api/agent/quiz/${encodeURIComponent(quizId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId, selectedIndex, player: playerId() }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as SharedQuizGrade;
}
