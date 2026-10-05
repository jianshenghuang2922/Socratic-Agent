import { NextResponse } from 'next/server';
import { limits } from '@/server/config';
import { expandQuery } from '@/server/expand';
import { jsonError, readJson, toErrorResponse } from '@/server/http';
import { contextForQuestion } from '@/server/rag';
import { searchWithExpansion } from '@/server/retrieve';
import { getContext, getIndex } from '@/server/store';

export const runtime = 'nodejs';

/**
 * POST /api/agent/inspect
 * body: { contextId, query?, round?, expand? }
 *
 * 仅开发环境可用的检索调试端点 —— 用来量化检索效果，而不是靠感觉调参。
 * 返回索引规模、命中块与分数，并对比「扩展前 / 扩展后」的召回差异，
 * 便于判断「中文提问能否命中英文代码」这类问题。
 * 生产环境直接 404。
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === 'production') {
    return jsonError(404, 'Not Found');
  }

  try {
    const body = await readJson<{
      contextId?: string;
      query?: string;
      round?: number;
      expand?: boolean;
      /** true 时返回命中块的完整文本，用于诊断块质量 */
      full?: boolean;
      /** 直接按标签模糊匹配导出块，用于看某个块到底长什么样 */
      label?: string;
    }>(req);
    const ctx = getContext(body.contextId);
    if (!ctx) return jsonError(410, '会话不存在');

    const index = getIndex(ctx);

    // 按标签导出块 —— 诊断「这个块凭什么排第一」时用
    if (body.label) {
      const matched = ctx.blocks.filter((b) => b.label.toLowerCase().includes(body.label!.toLowerCase()));
      return NextResponse.json({
        mode: 'dump',
        label: body.label,
        count: matched.length,
        blocks: matched.slice(0, 5).map((b) => ({
          label: b.label,
          category: b.category,
          chars: b.text.length,
          lines: b.text.split('\n').filter((l) => l.trim()).length,
          text: b.text.slice(0, 3000),
        })),
      });
    }

    const base = {
      title: ctx.title,
      kind: ctx.kind,
      blocks: ctx.blocks.length,
      indexedChunks: index.size,
      interactions: ctx.interactions.length,
      userQueries: ctx.userQueries.length,
      indexBudgetChars: limits.indexBudgetChars,
      answerBudgetChars: limits.answerBudgetChars,
      contextBudgetChars: limits.contextBudgetChars,
    };

    // 不带 query 时返回出题模式的召回结果
    if (!body.query) {
      const bundle = await contextForQuestion(ctx, body.round ?? 0);
      return NextResponse.json({
        ...base,
        mode: 'question',
        sources: bundle.sources,
        retrieved: bundle.retrieved,
        expanded: bundle.expanded ?? [],
        focus: bundle.focus.map((f) => f.prompt),
        contextChars: bundle.text.length,
        context: bundle.text.slice(0, 4000),
      });
    }

    const rawHits = index.search(body.query, limits.maxChunks);

    // expand=false 时只看纯 BM25，用于对比
    const terms = body.expand === false ? [] : (await expandQuery(ctx, body.query)).terms;
    const hits = searchWithExpansion(index, body.query, terms, limits.maxChunks);

    const brief = (list: typeof hits) =>
      list.map((h) => ({
        label: h.label,
        origin: h.origin,
        score: Number(h.score.toFixed(3)),
        chars: h.text.length,
        preview: body.full
          ? h.text.slice(0, 2000)
          : h.text.replace(/\s+/g, ' ').slice(0, 140),
      }));

    return NextResponse.json({
      ...base,
      mode: 'search',
      query: body.query,
      expanded: terms,
      rawHitCount: rawHits.length,
      hitCount: hits.length,
      hits: brief(hits),
      rawHits: brief(rawHits),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
