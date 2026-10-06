import { ApiError, readJson, toErrorResponse } from '@/server/http';
import { resolveSource } from '@/server/source';
import { requireContext } from '@/server/store';

export const runtime = 'nodejs';

/**
 * POST /api/agent/source
 * body: { contextId, label }   ->  SourceView
 *
 * 引用来源的「点开查看」。刻意是一次性 JSON 而不是 SSE：
 * 这是一个纯内存查表（在已建好的索引块里按标签找），中间没有任何可讲的步骤 ——
 * 硬套流式只会多一层解析，换不来任何等待期的信息。
 *
 * 错误约定与其它路由一致：400 参数错 / 404 该引用查不到 / 410 会话失效。
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<Record<string, unknown>>(req);
    const ctx = requireContext(typeof body.contextId === 'string' ? body.contextId : undefined);
    if (typeof body.label !== 'string') throw new ApiError(400, '缺少必填字段：label');
    return Response.json(resolveSource(ctx, body.label));
  } catch (err) {
    return toErrorResponse(err);
  }
}
