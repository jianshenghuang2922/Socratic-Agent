import { NextResponse } from 'next/server';
import { buildContext } from '@/server/context';
import { readLlmOverride } from '@/server/byok';
import { readJson, requireString } from '@/server/http';
import { claimTrial, toErrorResponseWithTrial, type TrialClaim } from '@/server/trial';

export const runtime = 'nodejs';
/** 克隆仓库可能较慢，放宽执行上限 */
export const maxDuration = 300;

/**
 * POST /api/agent/context
 * body: { url }
 *
 * 解析网页或代码仓库，建立问答上下文与检索索引，返回 contextId。
 * 注意这里会读入远多于 prompt 预算的内容 —— 全量索引、按需召回，
 * 这正是引入 RAG 后覆盖率提升的地方。
 *
 * 这是**一次性**版本：前端不再走它（它没有中间过程可讲，用户只能干等），
 * 但保留对外契约 —— 脚本化调用，以及 `e2e.mjs` / `verify-runtime.mjs`
 * 这类回归都依赖它。需要看到进度请用 `POST /api/agent/context/stream`。
 */
export async function POST(req: Request) {
  let claim: TrialClaim | null = null;
  try {
    const body = await readJson<{ url?: string }>(req);
    const url = requireString(body.url, 'url', 2048);
    /*
     * 参数校验通过才占额度：畸形请求不该消耗用户的免费次数。
     * 必须把 override 传进去 —— 带了自带 Key 的请求不占服务端额度，
     * 否则「填了 Key 就不受限」这句承诺就是假的。
     */
    claim = claimTrial(req, readLlmOverride(req));
    return NextResponse.json(await buildContext(url));
  } catch (err) {
    claim?.refund();
    return toErrorResponseWithTrial(err, req);
  }
}
