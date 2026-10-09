/**
 * 检索层。
 *
 * 说明一下为什么是 BM25 而不是向量检索：
 * 当前网关（OpenRouter）对 /embeddings 返回 403，CodeBuddy 网关返回 404，
 * 拿不到任何 embedding 接口。与其做一个跑不起来的「假 RAG」，
 * 不如把稀疏检索做到位 —— BM25 是 RAG 最早的检索器，至今仍是强基线。
 *
 * 稠密路径**不存在**，也不是「预留接口」：全仓没有 `embeddings.ts`、
 * 没有 `hybridSearch`、没有 `EMBEDDING_*` 配置（曾有过一个只用来关掉跨语言
 * 映射的 `embeddingConfig()`，已删，理由见 `config.ts` 末尾）。
 * 真要接混合检索，复用下面的 `rrf()` —— 它是通用的排名融合原语。
 *
 * 决定检索质量的主要是三件事，都在这儿：
 *  1. 分词能同时处理中文提问与英文标识符；
 *  2. 块带来源标签（文件路径 / 标题层级），命中标签时加权；
 *  3. 长度归一，避免长块仅因体量大而霸榜。
 */

import type { SourceBlock } from './sources/types';

/* ------------------------------------------------------------------ */
/* 分词                                                                */
/* ------------------------------------------------------------------ */

/**
 * 中文虚词表，用作**切分点**。
 *
 * 这是中文检索最大的噪声来源：把整句话无脑切二元组，
 * 「请求是怎么真正发出去的」会产出
 *   请求 / 求是 / 是怎 / 怎么 / 么真 / 真正 / 正发 / 发出 / 出去 / 去的
 * 十个词元，其中只有「请求」「发出」有信息量。剩下的跨虚词碎片会随机命中
 * 任何一段中文文本 —— 实测里导航菜单块就是这么霸榜的。
 *
 * 把它们当切分点（而不是删掉后拼接），二元组就不会跨越虚词边界。
 */
const CJK_STOPWORDS = [
  '为什么', '怎么样', '怎么', '什么', '如何', '怎样', '哪些', '哪个', '哪里',
  '这个', '那个', '这些', '那些', '这样', '那样', '这里', '那里',
  '可以', '需要', '应该', '是否', '有没有', '一个', '一些', '一下', '一直',
  '我们', '你们', '他们', '以及', '或者', '但是', '因为', '所以', '如果', '那么',
  '而且', '并且', '然后', '还有', '就是', '不是', '没有', '已经', '正在',
  '能够', '可能', '用来', '用于', '进行', '时候', '地方', '东西', '情况',
  '关于', '对于', '通过', '根据', '按照', '由于', '为了', '之后', '之前',
  '里面', '非常', '比较', '特别', '更加', '总是', '经常', '有时', '等等',
  '主要', '一般', '通常', '其实', '只是', '还是', '或者', '甚至',
];

/** 单字虚词，同样作为切分点。刻意不包含 上/下/中/里/到/对/为/从 这类
 *  —— 它们在「上传」「下载」「中间件」里是有实义的，切掉反而丢信息。 */
const CJK_PARTICLES = /[的了是吗呢吧啊呀哦嗯嘛着过和与及或之而么]/;

/** 按虚词切分出有实义的片段 */
function cjkSegments(run: string): string[] {
  let text = run;
  for (const w of CJK_STOPWORDS) {
    if (text.includes(w)) text = text.split(w).join('\u0000');
  }
  return text
    .split('\u0000')
    .flatMap((s) => s.split(CJK_PARTICLES))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** camelCase / snake_case / kebab-case 拆开，但保留原标识符 */
function latinTokens(raw: string): string[] {
  const out: string[] = [];
  const parts = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // HTTPServer -> HTTP Server
    .split(/[_$.\-/]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length >= 2);
  out.push(...parts);
  // 完整标识符单独保留：用户直接问 `dispatchRequest` 时，精确命中应该更值钱
  const whole = raw.toLowerCase();
  if (whole.length >= 4 && !out.includes(whole)) out.push(whole);
  return out;
}

/**
 * 抽词元。
 * - 拉丁/数字：按 camelCase、snake_case 拆词，并保留完整标识符
 * - 中文：先按虚词切段，再对每段取二元组（单字段保留原字）
 */
/**
 * 只抽拉丁/数字标识符词元（文件名、函数名、配置项）。
 *
 * 为什么单独开一个出口：判断「两道题是不是同一个知识点」时，
 * 中文句式是最强的噪声 —— 同一批资料出的题天然共用模板
 * （「在 X 中，Y 的主要职责是什么？」），拿整句算重合率，
 * 两道考不同函数的题也会被判成重复。而代码仓库里的知识点
 * 几乎都落在标识符上，只比标识符就能把两类干净分开。
 */
export function tokenizeIdentifiers(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z0-9_$]+/g) ?? []) out.push(...latinTokens(raw));
  return out;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];

  const latin = text.match(/[A-Za-z0-9_$]+/g) ?? [];
  for (const raw of latin) out.push(...latinTokens(raw));

  const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
  for (const run of cjk) {
    for (const seg of cjkSegments(run)) {
      if (seg.length === 1) {
        out.push(seg);
        continue;
      }
      for (let i = 0; i < seg.length - 1; i += 1) out.push(seg.slice(i, i + 2));
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 索引                                                                */
/* ------------------------------------------------------------------ */

export interface RetrievalDoc {
  id: string;
  /** 人类可读来源，会随召回结果一起注入 prompt */
  label: string;
  /** 层级路径，命中时加权 */
  path: string[];
  text: string;
  /** 'project' = URL 解析出的内容；'memory' = 用户交互记录 */
  origin: 'project' | 'memory';
}

export interface ScoredDoc extends RetrievalDoc {
  score: number;
}

/** BM25 参数 —— k1 控制词频饱和，b 控制长度归一强度 */
const K1 = 1.2;
const B = 0.75;
/**
 * 标签词频加权。
 * 文件名/标题里出现查询词，比正文里出现重要得多：
 * 问 `dispatchRequest` 时，名为 dispatchRequest.js 的文件应该排在
 * 「某处注释里提了一句 dispatchRequest」的块前面。
 */
const LABEL_BOOST = 4;

interface IndexedDoc {
  doc: RetrievalDoc;
  tf: Map<string, number>;
  len: number;
}

export class BM25Index {
  private docs: IndexedDoc[] = [];
  private df = new Map<string, number>();
  private totalLen = 0;
  private dirty = true;
  private avgLen = 1;

  get size(): number {
    return this.docs.length;
  }

  add(doc: RetrievalDoc): void {
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    // 标签（label + 各层级路径）额外加权
    const labelTokens = tokenize([doc.label, ...doc.path].join(' '));
    for (const t of labelTokens) tf.set(t, (tf.get(t) ?? 0) + LABEL_BOOST);

    // 同一文档里出现过的词只计一次 df
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);

    this.docs.push({ doc, tf, len: tokens.length + labelTokens.length });
    this.totalLen += tokens.length + labelTokens.length;
    this.dirty = true;
  }

  private ensureAvg(): void {
    if (!this.dirty) return;
    this.avgLen = this.docs.length > 0 ? this.totalLen / this.docs.length : 1;
    this.dirty = false;
  }

  private idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    const n = this.docs.length;
    // BM25+ 形式的 IDF，保证 df 很高时仍为正
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** 单文档打分，供调试与测试使用 */
  scoreDoc(index: number, queryTokens: string[]): number {
    this.ensureAvg();
    const { tf, len } = this.docs[index];
    let score = 0;
    for (const q of new Set(queryTokens)) {
      const f = tf.get(q);
      if (!f) continue;
      const norm = 1 - B + (B * len) / this.avgLen;
      score += this.idf(q) * ((f * (K1 + 1)) / (f + K1 * norm));
    }
    return score;
  }

  search(query: string, topK: number): ScoredDoc[] {
    if (this.docs.length === 0) return [];
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scored: ScoredDoc[] = [];
    for (let i = 0; i < this.docs.length; i += 1) {
      const score = this.scoreDoc(i, queryTokens);
      if (score > 0) scored.push({ ...this.docs[i].doc, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

/* ------------------------------------------------------------------ */
/* 从块建索引                                                          */
/* ------------------------------------------------------------------ */

export function buildIndex(blocks: SourceBlock[], origin: 'project' | 'memory' = 'project'): BM25Index {
  const index = new BM25Index();
  blocks.forEach((b, i) => {
    index.add({
      id: `${origin}-${i}`,
      label: b.label,
      path: b.path,
      text: b.text,
      origin,
    });
  });
  return index;
}

/* ------------------------------------------------------------------ */
/* 召回 → 拼上下文                                                     */
/* ------------------------------------------------------------------ */

export interface RetrieveResult {
  /** 拼好的上下文，直接进 prompt */
  text: string;
  /** 命中的来源，用于展示与调试 */
  hits: ScoredDoc[];
}

/** 块与块之间的分隔符 —— 预算计算要和它保持一致 */
const BLOCK_SEPARATOR = '\n\n---\n\n';

/**
 * 按预算把召回结果拼成上下文。
 * 每块前面统一加来源标记，模型据此引用具体文件/章节。
 */
export function assembleContext(items: { label: string; text: string }[], budget: number): string {
  const parts: string[] = [];
  let used = 0;

  for (const item of items) {
    const header = `【来源：${item.label}】`;
    const piece = `${header}\n${item.text}`;
    if (used + piece.length > budget) {
      // 还有余量就截一段，否则直接停
      const room = budget - used - header.length;
      if (room < 200) break;
      parts.push(`${header}\n${item.text.slice(0, room)}\n…（本段已截断）`);
      used = budget;
      break;
    }
    parts.push(piece);
    // 加上即将插入的分隔符长度，否则预算会被分隔符悄悄撑爆
    used += piece.length + BLOCK_SEPARATOR.length;
  }

  return parts.join(BLOCK_SEPARATOR);
}

/** 召回 + 拼装，最常用的组合 */
export function retrieve(
  index: BM25Index,
  query: string,
  budget: number,
  maxChunks: number,
): RetrieveResult {
  const hits = index.search(query, maxChunks);
  return { text: assembleContext(hits, budget), hits };
}

/* ------------------------------------------------------------------ */
/* 排名融合（RRF）                                                     */
/* ------------------------------------------------------------------ */

/**
 * Reciprocal Rank Fusion。
 *
 * 为什么不直接把扩展词拼进原查询：拼接是「分数相加」，一个命中面很宽的词
 * （比如到处都出现的 defaults）会把它所在的块抬到所有查询的第一名。
 * 实测里这会让 transformData 这种通用模块霸占各种不相关问题的首位。
 *
 * RRF 只看**排名**不看分数，天然免疫量纲差异，也让宽泛词无法靠高分压过精准词。
 * 不同来源可以给不同权重：扩展词是项目里的真实标识符，比原始中文查询更可信。
 */
export function rrf(
  lists: { hits: ScoredDoc[]; weight: number }[],
  topK: number,
  k = 60,
): ScoredDoc[] {
  const acc = new Map<string, { doc: ScoredDoc; score: number }>();

  for (const { hits, weight } of lists) {
    hits.forEach((doc, rank) => {
      const key = `${doc.origin}:${doc.label}:${doc.id}`;
      const add = weight / (k + rank + 1);
      const cur = acc.get(key);
      if (cur) cur.score += add;
      else acc.set(key, { doc, score: add });
    });
  }

  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((v) => ({ ...v.doc, score: Number(v.score.toFixed(6)) }));
}

/**
 * 带查询扩展的检索：原始查询与扩展词各搜一遍，再按排名融合。
 * 没有扩展词时退化为单次 BM25。
 *
 * `onFused` 是给思考轨迹用的回调 —— 融合**之后**才知道谁是第一，
 * 这时候告诉用户「命中了什么、有多强」才不是瞎猜。
 * 它是纯观察者：不参与排序，抛出异常也只影响轨迹、不影响检索结果。
 */
export function searchWithExpansion(
  index: BM25Index,
  query: string,
  terms: string[],
  topK: number,
  onFused?: (result: { fused: ScoredDoc[]; fromTerms: number; fromQuery: number }) => void,
): ScoredDoc[] {
  if (terms.length === 0) {
    const hits = index.search(query, topK);
    onFused?.({ fused: hits, fromTerms: 0, fromQuery: hits.length });
    return hits;
  }

  const fromQuery = index.search(query, topK * 2);
  const fromTerms = index.search(terms.join(' '), topK * 2);

  const fused = rrf(
    [
      // 扩展词是项目里真实存在的标识符，权重更高
      { hits: fromTerms, weight: 1 },
      // 原始中文查询主要用来兜住「用户已经用了项目词汇」的情况
      { hits: fromQuery, weight: 0.3 },
    ],
    topK,
  );

  onFused?.({ fused, fromTerms: fromTerms.length, fromQuery: fromQuery.length });
  return fused;
}

/* ------------------------------------------------------------------ */
/* 无查询词时的滚动取窗口（兜底）                                       */
/* ------------------------------------------------------------------ */

/**
 * 按轮次在正文里滚动取一个窗口。
 * 检索不可用（或召回为空）时兜底，保证出题至少还有资料可依。
 */
export function pickWindow(content: string, round: number, budget: number): string {
  if (content.length <= budget) return content;

  const stride = Math.max(Math.floor(budget * 0.6), 1);
  const start = (((round * stride) % content.length) + content.length) % content.length;
  const end = start + budget;

  if (end <= content.length) return content.slice(start, end);

  // 环绕：尾部 + 头部拼接，保证每次喂给模型的长度稳定
  return `${content.slice(start)}\n\n…\n\n${content.slice(0, end - content.length)}`;
}
