import { NextResponse } from 'next/server';
import { hasServerCredentials, llmConfig } from '@/server/config';
import { trialQuota } from '@/server/trial';

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
 */
export async function GET(req: Request) {
  const configured = hasServerCredentials();

  return NextResponse.json({
    /** 服务端是否配了模型凭据 */
    llmConfigured: configured,
    /** 服务端默认模型（仅用于界面展示；没配凭据时不暴露） */
    model: configured ? llmConfig().model : '',
    /** 是否接受请求级的自定义凭据（BYOK）。当前实现恒为 true */
    byok: true,
    /**
     * 免费试用额度。服务端没配凭据时 `available` 为 false，
     * 前端据此退回「必须自带 Key」的老逻辑。
     */
    trial: trialQuota(req),
  });
}
