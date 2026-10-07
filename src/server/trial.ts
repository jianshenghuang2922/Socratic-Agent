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
 * 两层限制：per-visitor（防止单个人刷）+ 全局（护住服务端账号的上游配额）。
 * 全局那层不是冗余 —— 访客身份来自 Cookie / `x-forwarded-for`，都可伪造，
 * 全局上限才是不依赖任何客户端输入的硬约束。
 *
 * ⚠️ 「访客」不等于「IP」，这是踩过的坑：
 *   早先只用 `x-forwarded-for` 的最后一段当身份，结果线上额度会被**刷新页面**重置。
 *   原因是最后一段并不是访客的地址，而是边缘节点的地址 —— 它既每次请求都可能变
 *   （换个边缘节点就是新桶 ⇒ 刷新即重置），又会被成百上千个真实用户共享
 *   （陌生人把你的额度用光 ⇒ 你还没用就报「额度已用完」）。
 *   现在身份以浏览器 Cookie 为主、IP 只作兜底，两者都不再影响正常访客。
 */

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { hasServerCredentials, limits, type LlmOverride } from './config';
import { ApiError, toErrorResponse } from './http';

/**
 * 没有免费额度时的原因。有额度时为 null。
 *
 * 这两个原因在外部**表现完全一样**（都是 `available: false` → 入口要求自带 Key），
 * 但处置方式相反：一个是运维有意为之，另一个是漏配环境变量的事故。
 * 不区分就只能去读源码 —— 见下面的 `trialUnavailableReason()`。
 */
export type TrialUnavailableReason =
  /** 运维显式关闭（TRIAL_ENABLED=0）—— 有意为之，无需处理 */
  | 'disabled'
  /** ⚠️ 误配：TRIAL_ENABLED=1 但服务端没有任何模型凭据 —— 额度根本发不出来 */
  | 'no_server_credentials';

/** 暴露给前端的额度状态（不含任何凭据信息） */
export interface TrialQuota {
  /** 这个部署是否提供免费额度：服务端配了凭据 + 未显式关闭 */
  available: boolean;
  /**
   * `available` 为 false 时说明原因，为 true 时为 null。
   *
   * 加这个字段的直接原因是踩过的坑：线上漏配 `OPENAI_API_KEY`，
   * `trialEnabled()` 于是为 false，入口**静默**退化成「必须自带 API Key」。
   * 从外部看，这和「免费额度功能压根没做」一模一样，只能去读源码才能分辨。
   * 现在 `curl /api/agent/config` 一眼就能读出是哪种。
   */
  reason: TrialUnavailableReason | null;
  /** 本访客在窗口内的总次数 */
  limit: number;
  /** 本访客已用 */
  used: number;
  /** 本访客剩余（全局用尽时也会归零） */
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
  /**
   * 所有额度桶。键由 `visitorOf()` 给出，两种形状：
   *   `v:<vid>`   带 Cookie 的浏览器 —— 正常访客走这条，刷新不会重置；
   *   `i:<ip>`    没带 Cookie 的客户端（脚本 / 首次请求）—— 兜底。
   * 前缀是必须的：没有它，一个 vid 恰好等于某个 IP 时两者会共用同一个桶。
   */
  keys: Map<string, Bucket>;
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

/*
 * ⚠️ 必须按**形状**判断能不能复用，不能只判断「有没有」。
 * globalThis 上的对象在 dev 热重载后仍然活着，而这个结构改过一次
 * （`ips: Map<ip, Bucket>` → `keys: Map<key, Bucket>`）：
 * 直接复用旧对象会拿到一个没有 `keys` 的 store，每个请求都在 TypeError 上崩掉。
 */
const store: TrialStore =
  globalThis.__socraticTrial?.keys instanceof Map
    ? globalThis.__socraticTrial
    : (globalThis.__socraticTrial = { keys: new Map(), global: null });

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** 桶表上限。超过就淘汰最久没动的，避免伪造身份把内存撑爆 */
const MAX_TRACKED_KEYS = 10_000;

/**
 * 免费额度为什么不可用；可用时返回 null。
 *
 * 单独抽出来是为了让「不可用」这件事**可被外部观测**。
 * 原先这个判断内联在 `trialEnabled()` 里，外部只能拿到一个布尔值，
 * 分不清是「运维主动关掉了」还是「环境变量漏配了」—— 而后者是事故。
 */
export function trialUnavailableReason(): TrialUnavailableReason | null {
  if (!limits.trialEnabled) return 'disabled';
  if (!hasServerCredentials()) return 'no_server_credentials';
  return null;
}

export function trialEnabled(): boolean {
  return trialUnavailableReason() === null;
}

/*
 * ⚠️ 启动时喊一声 —— 这是本项目最常见的部署事故。
 *
 * `TRIAL_ENABLED=1` 但服务端一个模型凭据都没有时，`trialEnabled()` 为 false，
 * 入口会**静默**退化成「必须自带 API Key」，从外部看和「额度功能没做」
 * 完全无法区分（我们为此排查了一轮）。日志里主动说破，省掉下次的猜测。
 * 用 globalThis 去重，免得 dev 热重载把它刷满屏。
 */
declare global {
  // eslint-disable-next-line no-var
  var __socraticTrialWarned: boolean | undefined;
}

if (trialUnavailableReason() === 'no_server_credentials' && !globalThis.__socraticTrialWarned) {
  globalThis.__socraticTrialWarned = true;
  console.warn(
    '[trial] TRIAL_ENABLED=1，但服务端没有模型凭据（OPENAI_API_KEY / CODEBUDDY_API_KEY 均为空）。\n' +
      '        免费额度不会生效，入口将退化为「必须自带 API Key」。\n' +
      '        修复：在该服务的环境变量里补上 OPENAI_API_KEY 与 OPENAI_BASE_URL。',
  );
}

/**
 * 取客户端 IP。
 *
 * ⚠️ 取**第一段**，不是最后一段。
 * `X-Forwarded-For` 的每一跳追加的是「**它看到的对端**」地址，所以链路是
 * `<真实客户端>, <第一层代理>, <第二层代理>…` —— 最左边才是访客，最右边是
 * 离服务最近的那台代理。原来取最后一段，等于拿边缘节点的地址当访客身份，
 * 线上表现为「刷新页面额度就重置」（换边缘节点 = 换桶）以及「额度被陌生人吃光」
 * （同一个边缘节点后面挂着成千上万个真实用户，共用一个桶）。
 *
 * ⚠️ 残余风险：本函数读的全是**请求头**，客户端可以自己伪造。
 * 平台代理是否覆盖/追加它们取决于部署环境，这里无法保证。
 * 因此本函数的返回值只用于「公平分配」，**不能当作安全边界** ——
 * 真正的兜底是 `limits.trialGlobal`（与任何客户端输入无关）以及服务端账号自己的上游配额。
 * 这也是为什么正常访客一律走 Cookie 身份，IP 只在没有 Cookie 时兜底。
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return parts[0].slice(0, 64);
  }
  return req.headers.get('x-real-ip')?.trim().slice(0, 64) || 'unknown';
}

/* ------------------------------------------------------------------ */
/* 访客身份                                                            */
/* ------------------------------------------------------------------ */

/** 访客标识 Cookie 名 */
const VISITOR_COOKIE = 'socratic_vid';
const VISITOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
/**
 * 只接受这个形状：16 字节的 hex。
 * 畸形值一律当作「没有 Cookie」—— 否则一个超长 Cookie 就能把桶表撑爆。
 */
const VISITOR_RE = /^[0-9a-f]{32}$/;

/** 一次请求的访客身份 */
export interface Visitor {
  /** 额度桶的键 */
  key: string;
}

function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

/** 读出浏览器带来的访客 id；没有或畸形时返回 null */
export function readVisitorId(req: Request): string | null {
  const raw = parseCookies(req.headers.get('cookie')).get(VISITOR_COOKIE);
  return raw && VISITOR_RE.test(raw) ? raw : null;
}

/**
 * 首次访问要下发的 `Set-Cookie`；已经有合法 Cookie 时返回 null（不必重复下发）。
 *
 * 单独抽成函数（而不是塞进 `visitorOf`）是为了让**写 Cookie 这件事只在
 * 真正要回应访客的出口发生**：SSE 流、错误体这些出口不写 Cookie，
 * 就不会出现「同一个响应头被反复追加」的怪状。
 */
export function visitorCookie(req: Request): string | null {
  if (readVisitorId(req)) return null;
  const id = randomBytes(16).toString('hex');
  // Secure 只在 https 下发：本地 http 开发时带 Secure 的 Cookie 会被浏览器直接丢掉，
  // 表现为「本地怎么测都是新访客」，白查半天。
  const secure = (req.headers.get('x-forwarded-proto') ?? '').includes('https') ? '; Secure' : '';
  return `${VISITOR_COOKIE}=${id}; Path=/; Max-Age=${VISITOR_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * 同一次请求内只解析一次。
 *
 * 用 WeakMap 而不是「让每个调用方自己传」：`trialQuota()` 与 `claimTrial()`
 * 可能被同一个请求的不同代码路径分别调用，两者必须看到**同一个身份** ——
 * 否则「显示还剩几次」和「实际扣哪个桶」会对不上，而这种错位极难发现。
 */
const visitorCache = new WeakMap<Request, Visitor>();

export function visitorOf(req: Request): Visitor {
  const hit = visitorCache.get(req);
  if (hit) return hit;

  const vid = readVisitorId(req);
  /*
   * 有合法 Cookie ⇒ 认这个浏览器。
   * 刷新页面不会丢 Cookie，所以「刷新重置额度」这条路径被彻底堵死。
   */
  const visitor: Visitor = vid ? { key: `v:${vid}` } : { key: `i:${clientIp(req)}` };

  /*
   * ⚠️ 没有 Cookie 时**绝不能**临时生成一个 id 当身份。
   * 那样每个请求都是全新的桶，免费额度等于无限 —— 脚本刷一下就穿。
   * 身份必须是一个「下次还会带回来」的东西，所以这里只退回 IP：
   * 不精确（NAT 下会互相影响、可伪造），但不会凭空发额度。
   */
  visitorCache.set(req, visitor);
  return visitor;
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
  if (store.keys.size <= MAX_TRACKED_KEYS) return;
  const ordered = [...store.keys.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (const [key] of ordered.slice(0, store.keys.size - MAX_TRACKED_KEYS)) {
    store.keys.delete(key);
  }
}

/** 只读地算一次额度状态，不消耗任何东西 */
export function trialQuota(req: Request): TrialQuota {
  if (!trialEnabled()) {
    return {
      available: false,
      reason: trialUnavailableReason(),
      limit: 0,
      used: 0,
      remaining: 0,
      resetsInMs: 0,
    };
  }

  const now = Date.now();
  const perVisitor = bucketFor(store.keys.get(visitorOf(req).key), now);
  const global = bucketFor(store.global, now);

  // 全局余量决定这个人实际还能用几次 —— 否则界面会显示「还剩 8 次」，
  // 一提问却报「额度已用完」，用户只会觉得这站在骗人。
  const remaining = Math.max(
    0,
    Math.min(limits.trialPerVisitor - perVisitor.used, limits.trialGlobal - global.used),
  );

  return {
    available: true,
    reason: null,
    limit: limits.trialPerVisitor,
    used: perVisitor.used,
    remaining,
    resetsInMs: Math.max(0, WINDOW_MS - (now - perVisitor.startedAt)),
  };
}

/**
 * 额度用尽的错误。
 *
 * 用 429 而不是 402：语义上是「请求过多」，且上游限流在本应用里一律被收敛成
 * 502（见 llm.ts），所以 429 在本站内不会和上游限流混淆。
 * 另外带上 `code` 与最新的 `trial` 状态，前端据此把额度显示归零并直接弹出设置面板。
 */
function exhaustedError(scope: 'visitor' | 'global'): ApiError {
  const message =
    scope === 'visitor'
      ? `你的免费额度已用完（${limits.trialPerVisitor} 次 / 24 小时）。点击页面右上角「模型设置」填入你自己的 API Key 即可继续 —— Key 只存在你的浏览器里，不会上传到服务端。`
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

  const key = visitorOf(req).key;
  const perVisitor = bucketFor(store.keys.get(key), now);
  store.keys.set(key, perVisitor);

  const global = bucketFor(store.global, now);
  store.global = global;

  // 先判全局：额度已经全站用尽时，说是「你的」额度用完会把锅甩给用户
  if (global.used >= limits.trialGlobal) throw exhaustedError('global');
  if (perVisitor.used >= limits.trialPerVisitor) throw exhaustedError('visitor');

  perVisitor.used += 1;
  global.used += 1;

  let refunded = false;
  return {
    refund() {
      if (refunded) return;
      refunded = true;
      /*
       * 这里持有的 perVisitor / global 是**对象引用**。
       * 若窗口在占用与退还之间滚过一轮，bucketFor 会新建对象替换掉旧的，
       * 我们手上的引用就变成了孤儿 —— 对孤儿自减不会影响线上计数，正是想要的行为。
       */
      if (perVisitor.used > 0) perVisitor.used -= 1;
      if (global.used > 0) global.used -= 1;
    },
  };
}

/** 仅测试用：清空所有计数 */
export function __resetTrialStore(): void {
  store.keys.clear();
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
