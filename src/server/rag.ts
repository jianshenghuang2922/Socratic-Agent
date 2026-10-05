/**
 * RAG 编排层。
 *
 * 把「项目内容」与「用户回复」两类内容合成一次检索增强，
 * 并针对不同用途给出不同的召回策略：
 *
 *  - 提问模式（ask）：按用户问题做相关性召回 —— 项目块 + 用户自己的历史作答/提问。
 *  - 出题模式（question）：没有查询词，改用「薄弱点回捞 + 全项目均匀采样」。
 *    薄弱点让题目针对这个人，均匀采样让题目覆盖整个项目而不是只盯着 README。
 *
 * 这一层是需求里「项目内容和用户回复作为检索增强内容」的落点。
 */

import { limits, type LlmOverride } from './config';
import { expandQuery } from './expand';
import { assembleContext, pickWindow, searchWithExpansion, type ScoredDoc } from './retrieve';
import { getIndex, weakSpots, type Interaction, type StoredContext } from './store';
import { emitTrace, scoreLabel, shortenLabel, type TraceSink } from './trace';
import type { SourceBlock } from './sources/types';

/** 检索融合结果的观察者载荷 */
interface FusionReport {
  fused: ScoredDoc[];
  fromTerms: number;
  fromQuery: number;
}

export interface RagBundle {
  /** 拼好的上下文，直接进 prompt */
  text: string;
  /** 命中的来源标签，便于展示与排查 */
  sources: string[];
  /** 本次召回是否用了检索（false = 走了兜底） */
  retrieved: boolean;
  /** 查询扩展补充进来的项目标识符（用于排查「中文问不中英文代码」） */
  expanded?: string[];
}

/** 按 label 去重，保留先出现的（相关性更高） */
function dedupeByLabel<T extends { label: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    out.push(item);
  }
  return out;
}

/**
 * 在项目里均匀采样若干块。
 *
 * 出题时没有查询词，如果每次都从开头取，模型会反复出同一批知识点。
 * 这里按块总数等距取样，并用轮次错开起点 —— 连续几道题自然散落到项目各处。
 */
export function sampleBlocks(blocks: SourceBlock[], round: number, count: number): SourceBlock[] {
  const pool = blocks.filter((b) => b.category !== 'meta' && b.text.trim().length >= 80);
  const usable = pool.length > 0 ? pool : blocks;
  if (usable.length === 0) return [];
  if (usable.length <= count) return usable;

  const step = Math.floor(usable.length / count);
  const start = (((round * 7) % usable.length) + usable.length) % usable.length;

  const out: SourceBlock[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(usable[(start + i * step) % usable.length]);
  }
  return out;
}

/**
 * 提问模式的召回。
 * 索引里同时有项目内容和用户历史，所以「我刚才答错的那题考的是什么」也能命中。
 *
 * 这里也是思考轨迹信息最密集的一段：查询扩展要调一次模型（数秒），
 * 检索决定了回答的依据。两者现在都讲给用户听。
 */
export async function contextForAsk(
  ctx: StoredContext,
  question: string,
  recentUserTurns: string[] = [],
  override?: LlmOverride,
  trace?: TraceSink,
): Promise<RagBundle> {
  const index = getIndex(ctx);
  const raw = expandShortQuestion(question, recentUserTurns);

  if (raw !== question) {
    emitTrace(trace, '检索', `提问较短，已拼接上一轮问题补全语义：${shortenLabel(raw, 60)}`);
  }

  // 中文提问先做一次标识符映射，否则召不回英文代码
  emitTrace(trace, '检索', `正在把提问映射到该项目真实存在的标识符（${ctx.blocks.length} 个资料块中检索）…`);
  const expansion = await expandQuery(ctx, raw, override);
  emitTrace(trace, '检索', expansion.reason);

  // TS 的控制流分析会认为回调「不一定执行」，于是把 fused 收窄成 never；
  // 用可变对象承接就能绕开这个误判。
  const report: { value: FusionReport | null } = { value: null };
  const hits = searchWithExpansion(index, raw, expansion.terms, limits.maxChunks, (result) => {
    report.value = result;
  });

  if (hits.length === 0) {
    emitTrace(
      trace,
      '检索',
      `没有召回到任何相关内容，退回按项目开头取材（回答将缺少针对性依据）。`,
    );
    return {
      text: pickWindow(ctx.content, 0, limits.answerBudgetChars),
      sources: [],
      retrieved: false,
      expanded: expansion.terms,
    };
  }

  const top = hits[0];
  const fusion = report.value;
  emitTrace(
    trace,
    '检索',
    `召回 ${hits.length} 个资料块${
      fusion && fusion.fromTerms > 0
        ? `（标识符检索 ${fusion.fromTerms} 命中，原始提问 ${fusion.fromQuery} 命中，按排名融合）`
        : ''
    }；最相关的是「${shortenLabel(top.label)}」（${scoreLabel(top.score)}）。`,
  );

  return {
    text: assembleContext(hits, limits.answerBudgetChars),
    sources: hits.map((h) => h.label),
    retrieved: true,
    expanded: expansion.terms,
  };
}

/** 提问很短（「它呢」「为什么」）时，把上一轮问题拼上，否则检索没有信息量 */
function expandShortQuestion(question: string, recentUserTurns: string[]): string {
  if (question.length >= 12) return question;
  const prev = recentUserTurns[recentUserTurns.length - 1];
  return prev ? `${prev} ${question}` : question;
}

export interface QuestionContext {
  /** 拼好的上下文 */
  text: string;
  sources: string[];
  /** 本次要针对的薄弱点（可能为空） */
  focus: Interaction[];
  retrieved: boolean;
  /** 查询扩展补充进来的项目标识符 */
  expanded?: string[];
}

/**
 * 出题模式的召回。
 *
 * 有薄弱点时，先按薄弱点的题干回捞原文 —— 这样再出的题是**同一个知识点的另一个角度**，
 * 而不是换个说法重复。再补一批均匀采样的块，保证题目不局限于历史错题。
 */
export async function contextForQuestion(
  ctx: StoredContext,
  round: number,
  override?: LlmOverride,
  trace?: TraceSink,
): Promise<QuestionContext> {
  const index = getIndex(ctx);
  const focus = weakSpots(ctx, 3);

  const picked: { label: string; text: string; score: number }[] = [];
  let expanded: string[] = [];

  // 1) 薄弱点回捞：每个薄弱点取最相关的 2 块
  if (focus.length > 0) {
    // 出题针对的是他的薄弱环节 —— 这件事必须说出来，
    // 否则用户会觉得题目是随机蹦出来的
    emitTrace(
      trace,
      '出题',
      `先回捞你之前的 ${focus.length} 个薄弱点：${focus
        .map((f) => shortenLabel(f.prompt, 34))
        .join('；')}`,
    );
    // 薄弱点题干同样是中文，一次性做扩展
    const focusText = focus.map((f) => `${f.prompt} ${f.knowledge}`).join(' ');
    const expansion = await expandQuery(ctx, focusText, override);
    expanded = expansion.terms;

    for (const it of focus) {
      const hits = searchWithExpansion(index, `${it.prompt} ${it.knowledge}`, expanded, 2);
      for (const hit of hits) {
        if (hit.origin !== 'project') continue;
        picked.push({ label: hit.label, text: hit.text, score: hit.score + 1000 });
      }
    }
  } else {
    emitTrace(trace, '出题', '还没有历史错题可参考，本轮完全按项目内容均匀取材。');
  }

  // 2) 全项目均匀采样，保证覆盖面
  const sampled = sampleBlocks(ctx.blocks, round, 6);
  for (const b of sampled) {
    picked.push({ label: b.label, text: b.text, score: 0 });
  }
  emitTrace(
    trace,
    '出题',
    `跨全项目均匀采样 ${sampled.length} 个资料块（第 ${round + 1} 轮，起点已错开，避免反复考同一段）。`,
  );

  const unique = dedupeByLabel(picked);
  if (unique.length === 0) {
    emitTrace(trace, '出题', '没有可取用的资料块，退回按正文窗口取材。');
    return {
      text: pickWindow(ctx.content, round, limits.contextBudgetChars),
      sources: [],
      focus,
      retrieved: false,
      expanded,
    };
  }

  emitTrace(
    trace,
    '出题',
    `锁定 ${unique.length} 个资料块作为出题范围，最相关的是「${shortenLabel(unique[0].label)}」。`,
  );

  return {
    text: assembleContext(unique, limits.contextBudgetChars),
    sources: unique.map((u) => u.label),
    focus,
    retrieved: true,
    expanded,
  };
}

/**
 * 只取用户记忆里的内容（历史作答 + 提过的问题）。
 * 用来给提示词补一段「这个人之前的表现」，不占资料预算。
 *
 * `trace` 传入时会汇报这次有没有带上用户记忆 —— 「它记得我答错过什么」
 * 是用户很难从回答正文里看出来的能力，讲出来才建立得起信任。
 */
export function memoryDigest(ctx: StoredContext, limit = 8, trace?: TraceSink): string {
  const lines: string[] = [];

  const weak = ctx.interactions.filter((it) => !it.correct).slice(-limit);
  if (weak.length > 0) {
    lines.push('【他答错过的题】');
    for (const it of weak) {
      lines.push(`- ${it.prompt}（他答：${it.userAnswer || '空'}）`);
    }
  }

  const strong = ctx.interactions.filter((it) => it.correct).slice(-4);
  if (strong.length > 0) {
    lines.push('【他已经答对的题】');
    for (const it of strong) lines.push(`- ${it.prompt}`);
  }

  const totalWeak = ctx.interactions.filter((it) => !it.correct).length;
  const totalStrong = ctx.interactions.filter((it) => it.correct).length;
  if (totalWeak + totalStrong > 0) {
    emitTrace(
      trace,
      '检索',
      `同时带上了你的历史表现作为参照：${totalWeak} 道错题、${totalStrong} 道已掌握。`,
    );
  }

  return lines.join('\n');
}

/** 命中来源的简表，供接口返回给前端展示「依据了哪些内容」 */
export function sourceSummary(hits: { label: string }[], limit = 5): string[] {
  return dedupeByLabel(hits).slice(0, limit).map((h) => h.label);
}
