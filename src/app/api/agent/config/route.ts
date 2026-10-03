import { NextResponse } from 'next/server';
import { hasServerCredentials, llmConfig } from '@/server/config';

export const runtime = 'nodejs';
/** 必须按请求实时读取 env，不能被构建期静态化 */
export const dynamic = 'force-dynamic';

/**
 * GET /api/agent/config
 *
 * 只回答一个问题：**这个部署自己有没有模型凭据**。
 *
 * 前端拿它来决定要不要引导用户填自己的 API Key —— 公网部署（Render 等）
 * 通常不配服务端 Key，用户进去只会看到「未配置模型凭据」的报错，
 * 与其让他自己猜，不如进页面就说清楚。
 *
 * 注意：这里只回布尔值，绝不回传 Key 本身，也不回传网关地址。
 */
export async function GET() {
  const configured = hasServerCredentials();

  return NextResponse.json({
    /** 服务端是否配了模型凭据 */
    llmConfigured: configured,
    /** 服务端默认模型（仅用于界面展示；没配凭据时不暴露） */
    model: configured ? llmConfig().model : '',
    /** 是否接受请求级的自定义凭据（BYOK）。当前实现恒为 true */
    byok: true,
  });
}
