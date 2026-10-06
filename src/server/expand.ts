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
 *
 * 返回值带 `reason`：这一步花了用户好几秒，且它决定了召回质量，
 * 必须能解释清楚「扩了没有、扩成了什么、为什么」，见 `ExpandOutcome`。
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
 * 扩展的产出：除了词表本身，还要说明**为什么**是这个结果。
 *
 * 调用方（rag 层）需要把这一步的决策讲给用户听，所以
 * 「跳过扩展」也必须是一个可解释的结果，不能只是返回空数组 ——
 * 空数组让「提问里没有中文」和「模型一个词都没映射出来」看起来一模一样，
 * 而这两种情况对用户的含义完全不同。
 */
export interface ExpandOutcome {
  terms: string[];
  /** 本次为何是这个结果，直接可作为思考轨迹的文案 */
  reason: string;
}

/**
 * 把查询扩展成「原查询 + 映射到的项目标识符」。
 * 失败一律降级为不扩展 —— 检索质量差一点，总好过整个请求挂掉。
 */
export async function expandQuery(
  ctx: StoredContext,
  query: string,
  override?: LlmOverride,
): Promise<ExpandOutcome> {
  const trimmed = query.trim();
  if (!trimmed) return { terms: [], reason: '提问为空，跳过查询扩展。' };

  // 关掉扩展时直接走纯 BM25
  if (!limits.ragExpandQuery) {
    return { terms: [], reason: '查询扩展已关闭，本轮走纯 BM25 字面检索。' };
  }

  // 已有稠密检索时不需要这套 —— 语义匹配是它本职
  if (embeddingConfig()) {
    return { terms: [], reason: '已启用向量检索，语义匹配足够，跳过标识符映射。' };
  }

  // 提问里没有中文，说明用户已经用了项目里的词汇，BM25 够用
  if (!/[\u4e00-\u9fff]/.test(trimmed)) {
    return { terms: [], reason: '提问未含中文，无需跨语言映射，直接按字面检索。' };
  }

  ctx.expansions ??= new Map();
  const cached = ctx.expansions.get(trimmed);
  if (cached) {
    return {
      terms: cached,
      reason: cached.length
        ? `沿用本会话已缓存的映射结果：${cached.slice(0, 6).join(' / ')}。`
        : '本会话此前对这同一个问题映射结果为空，直接复用（不再重复调用模型）。',
    };
  }

  const vocab = vocabulary(ctx);
  if (vocab.length === 0) {
    // 索引里一个可用名称都没有 —— 扩展无从下手，得让用户知道是这个原因
    return { terms: [], reason: '索引中未提取到可用标识符，本轮无法做跨语言映射。' };
  }

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
  let reason = '';
  // 调用失败（如当时还没配 Key）不写缓存 —— 否则用户补上 Key 之后，
  // 同一个问题会一直命中那条「空结果」缓存，检索质量再也回不来。
  let cacheable = true;
  try {
    const raw = await chat(
      [
        { role: 'user', content: prompt },
      ],
      { temperature: 0.1, maxTokens: limits.llmMaxTokens, override },
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
    reason = terms.length
      ? `把中文概念映射到项目里真实存在的 ${terms.length} 个标识符：${terms.slice(0, 8).join(' / ')}${
          terms.length > 8 ? ` 等 ${terms.length} 个` : ''
        }。`
      : '模型没能把提问映射到任何已存在的标识符，本轮按字面检索。';
  } catch (err) {
    // 扩展是增强项，失败就退回纯 BM25
    if (!(err instanceof ApiError)) throw err;
    console.warn('[rag] 查询扩展失败，降级为纯 BM25：', err.message);
    terms = [];
    cacheable = false;
    reason = '查询扩展调用失败，已降级为纯字面检索（不影响回答，只影响召回精度）。';
  }

  if (cacheable) ctx.expansions.set(trimmed, terms);
  return { terms, reason };
}
