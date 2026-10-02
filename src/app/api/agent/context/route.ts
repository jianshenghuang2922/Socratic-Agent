import { NextResponse } from 'next/server';
import { isRepoUrl } from '@/lib/urlKind';
import { readJson, requireString, toErrorResponse } from '@/server/http';
import { loadRepo } from '@/server/sources/repo';
import { loadWeb } from '@/server/sources/web';
import { createContext } from '@/server/store';

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
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ url?: string }>(req);
    const url = requireString(body.url, 'url', 2048);

    const source = isRepoUrl(url) ? await loadRepo(url) : await loadWeb(url);

    const ctx = createContext({
      url,
      kind: source.kind,
      title: source.title,
      summary: source.summary,
      content: source.content,
      blocks: source.blocks,
    });

    return NextResponse.json({
      contextId: ctx.id,
      url: ctx.url,
      kind: ctx.kind,
      title: ctx.title,
      summary: ctx.summary,
      /** 解析出的正文字数，供前端展示内容规模 */
      size: ctx.content.length,
      /** 检索索引的块数 —— 前端可据此说明「可检索范围」 */
      chunks: ctx.blocks.length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
