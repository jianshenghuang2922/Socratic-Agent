import { NextResponse } from 'next/server';
import { buildContext } from '@/server/context';
import { readJson, requireString, toErrorResponse } from '@/server/http';

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
  try {
    const body = await readJson<{ url?: string }>(req);
    const url = requireString(body.url, 'url', 2048);
    return NextResponse.json(await buildContext(url));
  } catch (err) {
    return toErrorResponse(err);
  }
}
