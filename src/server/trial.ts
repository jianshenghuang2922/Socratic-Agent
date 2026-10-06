/**
 * 免费试用额度 —— 给没带自己 Key 的访客一份小额度，用服务端凭据兜底。
 *
 * 为什么必须有这个东西：
 *   - 公开部署挂一个共享 Key 且不限量 = 几分钟被刷爆；
 *   - 但一进门就要用户填 Key = 要他拿信用卡换空气，他还没看到任何价值。
 * 折中：先给一小份免费额度，用完再引导他自带 Key（BYOK）。
 *
 * 计数口径：**一次「会调用模型的动作」算一次**，与内部重试次数无关。
 * 一次提问内部可能重试 3 次、换 2 个模型，但对用户就是「一次」——
 * 按上游请求数计费会让用户完全无法预期自己的额度。
 *
 * 失败会退还：免费模型上游 429 是常态，不退还的话用户会被「白扣」到零，
 * 体验比没有额度更差。
 *
 * 两层限制：per-IP（防止单个人刷）+ 全局（护住服务端账号的上游配额）。
 * 全局那层不是冗余 —— IP 来自 `x-forwarded-for`，可伪造，全局上限才是不依赖
 * 任何客户端输入的硬约束。
 */

import { NextResponse } from 'next/server';
import { hasServerCredentials, limits, type LlmOverride } from './config';
import { ApiError, toErrorResponse } from './http';

/** 暴露给前端的额度状态（不含任何凭据信息） */
export interface TrialQuota {
  /** 这个部署是否提供免费额度：服务端配了凭据 + 未显式关闭 */
  available: boolean;
  /** 本 IP 在窗口内的总次数 */
  limit: number;
  /** 本 IP 已用 */
  used: number;
  /** 本 IP 剩余（全局用尽时也会归零） */
  remaining: number;
  /** 当前窗口还剩多少毫秒重置 */
  resetsInMs: number;
}

/** 额度用尽时给前端的机器可读标记 */
export const TRIAL_EXHAUSTED = 'trial_exhausted';

interface Bucket {
  used: number;
  /** 窗口起点。滚动 24 小时，不做自然日 —— 免去时区与「跨零点重置」的歧义 */
  startedAt: number;
  /** 最后活动时间，仅用于淘汰 */
  touchedAt: number;
}

interface TrialStore {
  ips: Map<string, Bucket>;
  global: Bucket | null;
}

/**
 * 挂在 globalThis 上。
 * 与 store.ts 同理：Next.js 开发模式会热重载模块，模块级变量会被清空，
 * 于是「刚用掉的额度」凭空回滚 —— 开发时看着能用，线上被刷爆。
 */
declare global {
  // eslint-disable-next-line no-var
  var __socraticTrial: TrialStore | undefined;
}

const store: TrialStore = (globalThis.__socraticTrial ??= { ips: new Map(), global: null });

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** IP 表上限。超过就淘汰最久没动的，避免伪造 IP 把内存撑爆 */
const MAX_TRACKED_IPS = 10_000;

export function trialEnabled(): boolean {
  return limits.trialEnabled && hasServerCredentials();
}

/**
 * 取客户端 IP。
 *
 * ⚠️ 残余风险：`x-forwarded-for` / `x-real-ip` 都是**请求头**，客户端可以自己伪造。
 * 平台代理是否覆盖/追加它们取决于部署环境，这里无法保证。
 * 因此本函数的返回值只用于「公平分配」，**不能当作安全边界** ——
 * 真正的兜底是 `limits.trialGlobal`（与 IP 无关）以及服务端账号自己的上游配额。
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    // 取最后一段：多数代理是「追加」真实 IP 到客户端给的值之后，
    // 因此最后一段比第一段更接近真实来源。
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  return req.headers.get('x-real-ip')?.trim().slice(0, 64) || 'unknown';
}

/** 取（必要时新建）一个未过期的桶。窗口过期即视为归零 */
function bucketFor(b: Bucket | null | undefined, now: number): Bucket {
  if (b && now - b.startedAt < WINDOW_MS) {
    b.touchedAt = now;
    return b;
  }
  return { used: 0, startedAt: now, touchedAt: now };
}

function sweep(now: number): void {
  if (store.ips.size <= MAX_TRACKED_IPS) return;
  const ordered = [...store.ips.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (const [ip] of ordered.slice(0, store.ips.size - MAX_TRACKED_IPS)) {
    store.ips.delete(ip);
  }
}

/** 只读地算一次额度状态，不消耗任何东西 */
export function trialQuota(req: Request): TrialQuota {
  if (!trialEnabled()) {
    return { available: false, limit: 0, used: 0, remaining: 0, resetsInMs: 0 };
  }

  const now = Date.now();
  const ip = clientIp(req);
  const perIp = bucketFor(store.ips.get(ip), now);
  const global = bucketFor(store.global, now);

  // 全局余量决定这个人实际还能用几次 —— 否则界面会显示「还剩 8 次」，
  // 一提问却报「额度已用完」，用户只会觉得这站在骗人。
  const remaining = Math.max(
    0,
    Math.min(limits.trialPerIp - perIp.used, limits.trialGlobal - global.used),
  );

  return {
    available: true,
    limit: limits.trialPerIp,
    used: perIp.used,
    remaining,
    resetsInMs: Math.max(0, WINDOW_MS - (now - perIp.startedAt)),
  };
}

/**
 * 额度用尽的错误。
 *
 * 用 429 而不是 402：语义上是「请求过多」，且上游限流在本应用里一律被收敛成
 * 502（见 llm.ts），所以 429 在本站内不会和上游限流混淆。
 * 另外带上 `code` 与最新的 `trial` 状态，前端据此把额度显示归零并直接弹出设置面板。
 */
function exhaustedError(scope: 'ip' | 'global'): ApiError {
  const message =
    scope === 'ip'
      ? `你的免费额度已用完（${limits.trialPerIp} 次 / 24 小时）。点击页面右上角「模型设置」填入你自己的 API Key 即可继续 —— Key 只存在你的浏览器里，不会上传到服务端。`
      : '今日全站免费额度已被用完（服务端共用一份上游配额）。点击页面右上角「模型设置」填入你自己的 API Key 即可继续，不受此限制影响。';

  return new ApiError(429, message, TRIAL_EXHAUSTED);
}

/** 一次额度占用的凭据；`refund()` 把额度退回去 */
export interface TrialClaim {
  /**
   * 动作失败、且**没有产生任何用户可见输出**时调用。
   * 用户拿到了半截回答也算「产生了输出」，不该退 —— 见 ask/stream 里的判定。
   */
  refund(): void;
}

/**
 * 占用一次免费额度。
 *
 * 返回 `null` 表示**不占用**，两种情况：
 *   - 用户带了自带 Key（BYOK 优先，本就不该动服务端额度）；
 *   - 服务端没配凭据或显式关闭了额度。
 *
 * 额度用尽直接抛 429 —— 调用方不需要自己判断。
 */
export function claimTrial(req: Request, override?: LlmOverride): TrialClaim | null {
  if (!trialEnabled()) return null;
  if (override?.apiKey) return null;

  const now = Date.now();
  sweep(now);

  const ip = clientIp(req);
  const perIp = bucketFor(store.ips.get(ip), now);
  store.ips.set(ip, perIp);

  const global = bucketFor(store.global, now);
  store.global = global;

  // 先判全局：额度已经全站用尽时，说是「你的」额度用完会把锅甩给用户
  if (global.used >= limits.trialGlobal) throw exhaustedError('global');
  if (perIp.used >= limits.trialPerIp) throw exhaustedError('ip');

  perIp.used += 1;
  global.used += 1;

  let refunded = false;
  return {
    refund() {
      if (refunded) return;
      refunded = true;
      /*
       * 这里持有的 perIp / global 是**对象引用**。
       * 若窗口在占用与退还之间滚过一轮，bucketFor 会新建对象替换掉旧的，
       * 我们手上的引用就变成了孤儿 —— 对孤儿自减不会影响线上计数，正是想要的行为。
       */
      if (perIp.used > 0) perIp.used -= 1;
      if (global.used > 0) global.used -= 1;
    },
  };
}

/** 仅测试用：清空所有计数 */
export function __resetTrialStore(): void {
  store.ips.clear();
  store.global = null;
}

/**
 * 路由层统一出口。
 *
 * 与 `toErrorResponse` 的唯一区别：额度类错误会**额外带上最新的 trial 状态**。
 * 这样前端收到 429 的同一刻就能把计数器归零并弹出设置面板，
 * 不必再打一次 /config 去问「我到底还剩多少」—— 那一次往返恰好发生在
 * 用户最不耐烦的时刻。
 */
export function toErrorResponseWithTrial(err: unknown, req: Request) {
  if (err instanceof ApiError && err.code === TRIAL_EXHAUSTED) {
    return NextResponse.json(
      { error: err.message, code: err.code, trial: trialQuota(req) },
      { status: err.status },
    );
  }
  return toErrorResponse(err);
}
