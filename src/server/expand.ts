/**
 * 查询扩展 —— 补上稀疏检索跨不过去的那道鸿沟。
 *
 * 问题很具体：用户用中文问「请求是怎么真正发出去的？」，
 * 而代码里只有 `dispatchRequest` / `send` / `adapter`。
 * 两者没有任何字面重叠，BM25 再强也召不回来 —— 这不是调参能解决的。
 *
 * 解法：让模型把提问里的中文概念，映射到项目里**真实存在**的标识符上，
 * 再用「原提问 + 映射结果」一起检索。关键词是「真实存在」：
 * 我们把项目里的名称清单一并给它，要求原样输出，避免模型编造不存在的符号。
 *
 * 只在提问含中文时触发（英文提问本来就能命中），结果按 query 缓存。
 */

import { embeddingConfig, limits, type LlmOverride } from './config';
import { ApiError } from './http';
import { chat, extractJson } from './llm';
import type { StoredContext } from './store';

/** 从块标签里抽出「项目里真实存在的名称」清单 */
function vocabulary(ctx: StoredContext, limit = 300): string[] {
  const counts = new Map<string, number>();

  for (const b of ctx.blocks) {
    for (const seg of b.label.split(/[/›·.\s]+/)) {
      const t = seg.trim();
      if (t.length < 3) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

interface ExpandDraft {
  terms?: unknown;
}

/**
 * 把查询扩展成「原查询 + 映射到的项目标识符」。
 * 失败一律降级为不扩展 —— 检索质量差一点，总好过整个请求挂掉。
 */
export async function expandQuery(
  ctx: StoredContext,
  query: string,
  override?: LlmOverride,
): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // 关掉扩展时直接走纯 BM25
  if (!limits.ragExpandQuery) return [];

  // 已有稠密检索时不需要这套 —— 语义匹配是它本职
  if (embeddingConfig()) return [];

  // 提问里没有中文，说明用户已经用了项目里的词汇，BM25 够用
  if (!/[\u4e00-\u9fff]/.test(trimmed)) return [];

  ctx.expansions ??= new Map();
  const cached = ctx.expansions.get(trimmed);
  if (cached) return cached;

  const vocab = vocabulary(ctx);
  if (vocab.length === 0) return [];

  // 用完整标签文本做校验语料：模型常输出 `lib/core/dispatchRequest.js` 这种带路径写法，
  // 只认裸词会把它全部误杀
  const corpus = ctx.blocks
    .map((b) => b.label)
    .join('\n')
    .toLowerCase();

  const prompt = `你在帮一个中文用户检索代码库/文档。请把用户提问里的中文概念，映射到项目里**真实存在**的名称上。

用户提问：
${trimmed}

项目里真实存在的名称（节选，共 ${vocab.length} 个）：
${vocab.join(', ')}

要求：
1. 只输出上面列表中**原样出现**的名称，一个字都不要改，不要编造。
2. 优先给出与提问语义最接近的 5~12 个名称。
3. 如果提问里本身含英文标识符，也一并保留。
4. 只输出 JSON，不要代码围栏、不要解释：{"terms":["名称1","名称2"]}`;

  let terms: string[] = [];
  // 调用失败（如当时还没配 Key）不写缓存 —— 否则用户补上 Key 之后，
  // 同一个问题会一直命中那条「空结果」缓存，检索质量再也回不来。
  let cacheable = true;
  try {
    const raw = await chat(
      [
        { role: 'user', content: prompt },
      ],
      { temperature: 0.1, maxTokens: 2500, override },
    );
    const draft = extractJson<ExpandDraft>(raw, '查询扩展');
    if (Array.isArray(draft.terms)) {
      terms = draft.terms
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().replace(/^[`'"\s]+|[`'"\s]+$/g, ''))
        .filter((t) => t.length >= 2)
        // 只要能在项目标签里找到，就算合法 —— 宽松但仍有依据
        .filter((t) => corpus.includes(t.toLowerCase()))
        .slice(0, 12);
    }
  } catch (err) {
    // 扩展是增强项，失败就退回纯 BM25
    if (!(err instanceof ApiError)) throw err;
    console.warn('[rag] 查询扩展失败，降级为纯 BM25：', err.message);
    terms = [];
    cacheable = false;
  }

  if (cacheable) ctx.expansions.set(trimmed, terms);
  return terms;
}
