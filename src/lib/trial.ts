/**
 * 免费额度的**客户端**状态。
 *
 * 为什么用外部 store 而不是 React state：
 * 额度的更新来自两处 —— 首次 `GET /api/agent/config`，以及每次 SSE 里的
 * `quota` 事件 —— 而 SSE 的消费发生在 `HttpAgentClient` 内部，那里没有
 * React 上下文，也没法往回传 props。用外部 store 让客户端可以直接写入、
 * 组件可以直接订阅，额度不必一路透传过组件树。
 *
 * 服务端那份在 `src/server/trial.ts`，两边只共享字段形状，不共享代码。
 */

/** 没有免费额度时的原因，与服务端 `TrialUnavailableReason` 保持一致 */
export type TrialUnavailableReason = 'disabled' | 'no_server_credentials';

export interface TrialQuota {
  /** 这个部署是否提供免费额度 */
  available: boolean;
  /**
   * `available` 为 false 时的原因（为 true 时为 null）。
   * 界面不直接展示它 —— 对访客来说「自带 Key」就是唯一出路，原因只对运维有意义；
   * 它的价值在于 `/api/agent/config` 能被一眼读懂，不必去翻源码。
   */
  reason?: TrialUnavailableReason | null;
  /** 本 IP 在 24 小时窗口内的总次数 */
  limit: number;
  /** 已用 */
  used: number;
  /** 剩余（全局额度耗尽时也会归零） */
  remaining: number;
  /** 窗口还剩多少毫秒重置 */
  resetsInMs: number;
}

let snapshot: TrialQuota | null = null;
const listeners = new Set<() => void>();

/**
 * 写入最新额度。
 *
 * 必须做「值没变就不通知」的判断：`useSyncExternalStore` 会拿返回值做
 * 引用比较，每次 SSE 都塞一个新对象进去会让所有订阅者无谓重渲染。
 * 一次问答的流里有好几个事件，这个优化不是可有可无的。
 */
export function publishTrial(next: TrialQuota | null | undefined): void {
  if (!next || typeof next.remaining !== 'number') return;

  const prev = snapshot;
  if (
    prev &&
    prev.available === next.available &&
    prev.limit === next.limit &&
    prev.used === next.used &&
    prev.remaining === next.remaining
  ) {
    return;
  }

  snapshot = next;
  for (const l of listeners) l();
}

export function subscribeTrial(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getTrialSnapshot(): TrialQuota | null {
  return snapshot;
}

/** 服务端渲染时还没有任何额度信息，恒返回 null */
export function getServerTrialSnapshot(): TrialQuota | null {
  return null;
}
