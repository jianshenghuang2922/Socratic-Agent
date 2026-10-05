/**
 * 建立 URL 上下文 —— 解析内容、切块、建检索索引。
 *
 * 单独抽出来是因为有两个入口要用它：
 *   · `POST /api/agent/context`        一次性 JSON（对外契约、脚本化调用）
 *   · `POST /api/agent/context/stream` SSE（前端走这条，为了把进度讲出来）
 * 两个入口共用同一份实现，否则「JSON 那边建好的索引」和「流式那边建好的索引」
 * 迟早会漂移，而这类漂移只会在某个入口上悄悄发生。
 */

import { isRepoUrl } from '@/lib/urlKind';
import { loadRepo } from './sources/repo';
import { loadWeb } from './sources/web';
import { createContext } from './store';
import { emitTrace, type TraceSink } from './trace';

/** 建立上下文后回给前端的东西 */
export interface ContextPayload {
  contextId: string;
  url: string;
  kind: 'web' | 'repo';
  title: string;
  summary: string;
  /** 解析出的正文字数，供前端展示内容规模 */
  size: number;
  /** 检索索引的块数 —— 前端可据此说明「可检索范围」 */
  chunks: number;
}

export async function buildContext(rawUrl: string, trace?: TraceSink): Promise<ContextPayload> {
  const url = rawUrl.trim();
  const kind: 'web' | 'repo' = isRepoUrl(url) ? 'repo' : 'web';

  emitTrace(
    trace,
    '准备',
    kind === 'repo'
      ? '识别为代码仓库地址：将浅克隆仓库、扫描文本文件并建立代码索引。'
      : '识别为网页地址：将抓取页面、抽取正文并建立文档索引。',
  );

  const source = kind === 'repo' ? await loadRepo(url, trace) : await loadWeb(url, trace);

  emitTrace(trace, '索引', `正在为 ${source.blocks.length} 个语义块建立 BM25 检索索引…`);
  const ctx = createContext({
    url,
    kind: source.kind,
    title: source.title,
    summary: source.summary,
    content: source.content,
    blocks: source.blocks,
  });
  emitTrace(trace, '索引', `检索索引已就绪，上下文可以开始问答了（${ctx.blocks.length} 个语义块）。`);

  return {
    contextId: ctx.id,
    url: ctx.url,
    kind: ctx.kind,
    title: ctx.title,
    summary: ctx.summary,
    size: ctx.content.length,
    chunks: ctx.blocks.length,
  };
}
