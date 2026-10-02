import { limits } from '../config';
import { ApiError, describeNetworkError } from '../http';
import { categorize, isLowValueBlock, type LoadedSource, type SourceBlock } from './types';

const UA =
  'Mozilla/5.0 (compatible; SocraticAgent/1.1; +https://example.local) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  times: '×',
  divide: '÷',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  laquo: '«',
  raquo: '»',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * 极简 HTML → 纯文本。刻意不引依赖：正文抽取够用即可，模型能容忍噪声。
 *
 * 唯一「多做」的一件事是**保留标题层级**（转成 Markdown 的 `#` 前缀）。
 * 因为下游要靠标题切块 —— 没有标题层级，长文档只能按字数硬切，
 * 检索粒度会明显变差。
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|iframe|head|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre)>/gi, '\n')
      // 标题开标签转成 Markdown 前缀，供后续按层级切块
      .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(html: string, fallback: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1]) return decodeEntities(og[1]).trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) {
    const text = decodeEntities(title[1]).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return fallback;
}

/** 拒绝内网地址，避免被当成 SSRF 跳板 */
function assertPublicHost(url: URL): void {
  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) {
    throw new ApiError(400, '出于安全考虑，不允许抓取内网或本机地址');
  }
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
/** 单块目标长度：超过就再按段落切开 */
const CHUNK_TARGET = 1200;
/** 单块硬上限，防止出现几万字的巨块污染召回 */
const CHUNK_MAX = 2400;

/**
 * 按标题层级切块。
 * 每块记下自己的标题路径（如 ['快速上手', '安装']），检索时按路径加权，
 * 也能让模型知道这段内容在文档里的位置。
 */
export function chunkDocument(text: string, docTitle: string): SourceBlock[] {
  const lines = text.split('\n');
  const blocks: SourceBlock[] = [];

  /** 当前标题栈：[{level, text}] */
  let stack: { level: number; text: string }[] = [];
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    buf = [];
    if (!body) return;

    const path = [docTitle, ...stack.map((s) => s.text)];
    const label = path.join(' › ');

    // 单块过长时按段落再切，避免一段几万字的「巨块」污染检索
    if (body.length <= CHUNK_MAX) {
      blocks.push({ label, path, text: body, category: 'doc' });
      return;
    }
    const paras = body.split(/\n{2,}/);
    let acc: string[] = [];
    let size = 0;
    let part = 1;
    const pushPart = () => {
      const t = acc.join('\n\n').trim();
      acc = [];
      size = 0;
      if (!t) return;
      const l = `${label}（第 ${part} 段）`;
      blocks.push({ label: l, path, text: t, category: 'doc' });
      part += 1;
    };
    for (const p of paras) {
      if (size + p.length > CHUNK_TARGET) pushPart();
      acc.push(p);
      size += p.length + 2;
    }
    pushPart();
  };

  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      flush();
      const level = m[1].length;
      stack = stack.filter((s) => s.level < level);
      stack.push({ level, text: m[2].trim() });
      continue;
    }
    buf.push(line);
  }
  flush();

  if (blocks.length === 0) {
    const body = text.trim();
    if (body) {
      blocks.push({ label: docTitle, path: [docTitle], text: body, category: 'doc' });
    }
  }

  return blocks;
}

export async function loadWeb(rawUrl: string): Promise<LoadedSource> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'URL 格式不合法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, '只支持 http / https 协议的 URL');
  }
  assertPublicHost(url);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(limits.fetchTimeoutMs),
    });
  } catch (err) {
    throw new ApiError(502, describeNetworkError(err, '抓取网页'));
  }

  if (!response.ok) {
    throw new ApiError(
      502,
      `抓取网页失败：目标返回 ${response.status} ${response.statusText}${
        response.status === 404 ? '（页面不存在）' : ''
      }`,
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();

  const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw);
  const text = isHtml ? htmlToText(raw) : raw.trim();

  if (text.length < 80) {
    throw new ApiError(
      422,
      '该 URL 几乎没有可读正文（可能是纯前端渲染页面或需要登录），换一个页面或改用仓库 URL 试试',
    );
  }

  const title = isHtml ? extractTitle(raw, url.hostname) : url.hostname;
  const truncated = text.length > limits.indexBudgetChars;
  const content = truncated ? text.slice(0, limits.indexBudgetChars) : text;

  const blocks = chunkDocument(content, title).filter((b) => !isLowValueBlock(b.text));
  if (blocks.length === 0) {
    blocks.push({ label: title, path: [title], text: content, category: categorize(title) });
  }

  return {
    kind: 'web',
    title,
    summary: `已读取该网页正文，共 ${text.length.toLocaleString('zh-CN')} 字，切分为 ${blocks.length} 个语义块${
      truncated ? `（超出索引上限，已截取前 ${limits.indexBudgetChars.toLocaleString('zh-CN')} 字）` : ''
    }。`,
    content,
    blocks,
  };
}
