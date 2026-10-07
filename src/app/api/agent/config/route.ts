import { NextResponse } from 'next/server';
import { hasServerCredentials, llmConfig } from '@/server/config';
import { trialQuota, visitorCookie } from '@/server/trial';

export const runtime = 'nodejs';
/** 必须按请求实时读取 env 与额度计数，不能被构建期静态化 */
export const dynamic = 'force-dynamic';

/**
 * GET /api/agent/config
 *
 * 只回答两个问题：**这个部署自己有没有模型凭据**、**这个访客还剩多少免费额度**。
 *
 * 前端拿它决定入口怎么说话：
 *   - 有凭据 + 还有额度 ⇒ 直接放进来用，额度用完再引导自带 Key；
 *   - 有凭据但额度用尽 ⇒ 入口就说明白，别等用户提完问题才报错；
 *   - 没凭据 ⇒ 只能引导他自带 Key（BYOK）。
 *
 * 注意：这里只回布尔值与计数，绝不回传 Key 本身，也不回传网关地址。
 *
 * ⚠️ 这里也是**给访客发身份 Cookie 的唯一出口**，别挪走：
 *   页面每次加载都会打这个接口（`useServerLlmInfo` 挂载即请求），
 *   所以浏览器一定会在第一次动作之前拿到 Cookie —— 额度从此按浏览器计，
 *   刷新页面不再重置。少了它，访客只能按 IP 计数，而线上 IP 那段并不稳定
 *   （见 `clientIp()` 的说明），额度会被刷新重置、也会被同节点的陌生人吃光。
 */
export async function GET(req: Request) {
  const configured = hasServerCredentials();

  const res = NextResponse.json({
    /** 服务端是否配了模型凭据 */
    llmConfigured: configured,
    /** 服务端默认模型（仅用于界面展示；没配凭据时不暴露） */
    model: configured ? llmConfig().model : '',
    /** 是否接受请求级的自定义凭据（BYOK）。当前实现恒为 true */
    byok: true,
    /**
     * 免费试用额度。服务端没配凭据时 `available` 为 false，
     * 前端据此退回「必须自带 Key」的老逻辑。
     *
     * ⚠️ 这里的 `trial.reason` 是排障入口，别删：
     *    `no_server_credentials` = 服务端漏配了 OPENAI_API_KEY，
     *    免费额度根本发不出来（**曾经线上就是这个状态**）；
     *    `disabled` = 运维显式关了额度（TRIAL_ENABLED=0），属正常。
     *    两种情况下前端表现完全一致，只有这个字段能区分。
     */
    trial: trialQuota(req),
  });

  /*
   * 额度是**按访客**算的，所以这个响应绝不能被任何一层缓存共享出去 ——
   * 一旦被缓存，第二个访客会读到第一个人的计数（要么凭空多出额度，
   * 要么还没用就被告知「已用完」）。顺带把 `force-dynamic` 的意图落实成响应头。
   */
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');

  const cookie = visitorCookie(req);
  if (cookie) res.headers.append('Set-Cookie', cookie);

  return res;
}
