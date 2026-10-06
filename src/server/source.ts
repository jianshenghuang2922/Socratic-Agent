/**
 * 引用来源解析 —— 「点开引用文件直接查看」的服务端实现。
 *
 * 前端手里只有一串标签（`lib/core/Axios.js › interceptor`）。这个模块把它
 * 还原成用户能直接读的内容。两类来源的处理刻意不同：
 *
 *  · 代码仓库：标签指向**文件**，所以把同一文件的所有索引块按原顺序拼回整份文件，
 *    并把被引用的那一段标出来。用户点开是想看上下文 —— 只给那 20 行没有意义。
 *  · 网页：标签指向**章节**，页面本身才是「文件」。给出被引用的那一节，
 *    并附上原网页地址（章节级锚点无法可靠还原，硬拼 #hash 只会得到坏链接）。
 *
 * 内容全部取自会话里**已建好的索引块**：不重新抓取、不读磁盘。
 * 仓库的克隆目录在建立上下文后就删了，网页也没必要为了「看一眼」再抓一次。
 * 因此这是个纯内存查表，代价可以忽略。
 *
 * 一个必须说清的事实：仓库那份「整份文件」是由索引块拼回来的，块在切分时
 * 做过 trim，块与块之间也会补上分隔。它**不等于**磁盘上的原文。所以
 * 返回值里带 `chunks`（由几块拼成）和 `externalUrl`（去托管站看权威版本），
 * 由前端如实告诉用户，而不是假装这就是原文。
 */

import { parseRepo } from '@/lib/urlKind';
import { ApiError } from './http';
import type { StoredContext } from './store';
import type { SourceBlock } from './sources/types';
import type { SourceView } from '@/lib/types';

/**
 * 用户记忆块的根标签。
 * 这类标签代表「一条记录」而不是「一个文件」，绝不能按同文件规则聚合 ——
 * 否则点开某一次作答，会把这个人所有的作答记录一起倒出来。
 */
const MEMORY_ROOTS = new Set(['我的作答记录', '我提过的问题']);

/** 仓库清单是建立上下文时合成的伪文件，没有对应的真实文件 */
const MANIFEST_LABEL = '仓库清单';

/** 拼接块时的分隔符 —— 与 focus 区间计算共用同一份常量 */
const JOIN_SEP = '\n\n';

/** 单次返回的正文上限，避免把整个项目一次性吐给浏览器 */
const MAX_VIEW_CHARS = 200_000;

/** 标签形如 `路径 › 符号`，拆成文件部分与锚点 */
function splitLabel(label: string): { filePart: string; anchor: string | null } {
  const i = label.indexOf('›');
  if (i < 0) return { filePart: label.trim(), anchor: null };
  return {
    filePart: label.slice(0, i).trim(),
    anchor: label.slice(i + 1).trim() || null,
  };
}

/**
 * 推出「去托管站看这个文件」的地址。
 *
 * 只处理 URL 结构确定的几家站点；推不出来就返回 undefined ——
 * 给一个 404 的链接比不给链接更糟。分支名用 `HEAD`：
 * 建立上下文时是 `--depth 1 --single-branch`，具体分支名这里无从得知，
 * 而 GitHub / GitLab / Gitee 都认 `HEAD`。
 */
function externalUrlFor(ctx: StoredContext, filePart: string): string | undefined {
  if (ctx.kind !== 'repo') return ctx.url;
  if (MEMORY_ROOTS.has(filePart) || filePart === MANIFEST_LABEL) return undefined;

  let host: string;
  let origin: string;
  try {
    const u = new URL(ctx.url);
    host = u.hostname.replace(/^www\./, '').toLowerCase();
    origin = u.origin;
  } catch {
    return undefined;
  }

  const parsed = parseRepo(ctx.url);
  if (!parsed) return undefined;

  const base = `${origin}/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const path = filePart.split('/').map(encodeURIComponent).join('/');

  if (host === 'github.com' || host === 'gitee.com') return `${base}/blob/HEAD/${path}`;
  if (host === 'gitlab.com') return `${base}/-/blob/HEAD/${path}`;
  return undefined;
}

/**
 * 把标签解析成可查看的来源。
 *
 * 找不到对应块时抛 404 而不是 410：标签可能来自很久以前的回答，
 * 而会话还在（只是那个块因为索引上限没被纳入）。这两种情况的用户动作不同 ——
 * 前者是「这条引用查不到了」，后者是「整个会话过期了，请重新输入 URL」。
 */
export function resolveSource(ctx: StoredContext, rawLabel: string): SourceView {
  const label = rawLabel.trim();
  if (!label) throw new ApiError(400, '缺少必填字段：label');

  const { filePart, anchor } = splitLabel(label);
  const fileParts = filePart.split('/').filter(Boolean);

  /*
   * 同一文件的全部索引块。
   * 仓库块的 path 是 `文件路径.split('/')`（可选再追加一个符号名），
   * 所以「路径前缀一致」就是「同一个文件」。
   */
  const sameFile =
    fileParts.length > 0
      ? ctx.blocks.filter((b) => b.path.slice(0, fileParts.length).join('/') === fileParts.join('/'))
      : [];

  const exact = ctx.blocks.find((b) => b.label === label) ?? null;

  /*
   * 只有「仓库里的真实文件」才聚合：
   *  · 网页的标签前缀是页面标题，聚合等于把整页倒出来，用户要的是那一节；
   *  · 用户记忆块聚合会把所有作答记录混成一份「文件」。
   */
  const aggregate =
    ctx.kind === 'repo' &&
    !MEMORY_ROOTS.has(filePart) &&
    filePart !== MANIFEST_LABEL &&
    sameFile.length > 1;

  const blocks: SourceBlock[] = aggregate ? sameFile : exact ? [exact] : sameFile;
  if (blocks.length === 0) {
    throw new ApiError(404, `找不到引用来源「${label}」，它可能来自已经更新过的索引`);
  }

  const first = blocks[0];
  const texts = blocks.map((b) => b.text);

  let text = texts.join(JOIN_SEP);
  let truncated = false;
  if (text.length > MAX_VIEW_CHARS) {
    text = text.slice(0, MAX_VIEW_CHARS);
    truncated = true;
  }

  // 只有拼接出来的正文才需要标出「引用的是哪一段」；单块本身就是要看的东西
  let focus: SourceView['focus'];
  if (aggregate) {
    const cited = blocks.findIndex((b) => b.label === label);
    if (cited >= 0) {
      let start = 0;
      for (let i = 0; i < cited; i += 1) start += texts[i].length + JOIN_SEP.length;
      const end = start + texts[cited].length;
      // 正文被上限截断时区间可能落到界外，宁可不标也不要标错
      if (end <= text.length) focus = { start, end };
    }
  }

  return {
    label,
    kind: ctx.kind,
    category: first.category,
    // 仓库的「文件」就是路径本身；网页 / 记忆的第一段路径是页面标题或记录类别
    title: ctx.kind === 'repo' ? filePart : first.path[0] ?? filePart,
    anchor,
    text,
    focus,
    externalUrl: externalUrlFor(ctx, filePart),
    truncated: truncated || undefined,
    chunks: blocks.length,
  };
}
