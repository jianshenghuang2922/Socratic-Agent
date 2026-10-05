import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseRepo } from '@/lib/urlKind';
import { limits } from '../config';
import { ApiError, describeNetworkError } from '../http';
import { emitTrace, type TraceSink } from '../trace';
import { categorize, isLowValueBlock, type LoadedSource, type SourceBlock } from './types';

const run = promisify(execFile);

/**

/** 直接跳过的目录：依赖、产物、缓存，无一有分析价值 */
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor', 'dist', 'build',
  'out', '.next', '.nuxt', '.output', '.svelte-kit', 'coverage', '__pycache__', '.venv',
  'venv', 'env', '.tox', 'target', '.idea', '.vscode', '.gradle', 'Pods', 'DerivedData',
  '.cache', '.terraform', 'tmp', 'temp', 'logs',
]);

/** 二进制或低价值扩展名，直接跳过 */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.tiff', '.psd', '.ai',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.webm', '.ogg', '.flac',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.jar', '.war', '.class', '.exe', '.dll',
  '.so', '.dylib', '.bin', '.o', '.a', '.lib', '.pdb', '.wasm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.ppt', '.pptx', '.lock', '.map', '.snap', '.ipynb',
]);

/**
 * 压缩产物。
 * 不能用 `path.extname` 判断 —— `foo.min.js` 的扩展名是 `.js`，
 * 所以「.min.js」这类条目写在 SKIP_EXT 里永远不会命中，压缩文件照样进索引。
 */
const MINIFIED_RE = /\.min\.(js|css)$/i;

/** 目录树最大递归深度，防止畸形仓库把调用栈打爆 */
const MAX_WALK_DEPTH = 40;

const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Gemfile.lock',
  'poetry.lock', 'Cargo.lock', '.DS_Store', 'go.sum',
]);

/**
 * 文档站的脚手架文件 —— 导航配置、侧边栏、搜索索引。
 *
 * 这类文件的唯一内容是「这个站点的菜单长什么样」，对回答「这个库怎么工作」零价值。
 * 但它们的危害很大：一份中文侧边栏就是整个站点的中文标题清单，
 * 几乎涵盖文档里出现过的所有名词，任何中文提问都能在上面部分命中，
 * 于是稳定霸榜、把真正的代码块挤下去。
 *
 * 实测 axios 仓库：`docs/.vitepress/config.mts` 与
 * `docs/.vitepress/tokenizeSearchText.test.js` 两个文件，
 * 在 10 个不相关的中文提问里拿下了绝大多数第一名。
 */
const DOC_SCAFFOLD_DIRS = new Set(['.vitepress', '.vuepress', '.docusaurus', '.mkdocs']);

function isDocScaffolding(relPath: string): boolean {
  const segments = relPath.split('/');
  if (segments.some((s) => DOC_SCAFFOLD_DIRS.has(s.toLowerCase()))) return true;

  const base = path.basename(relPath).toLowerCase();
  if (/^_?sidebar\.(md|json|js|ts|mjs|yml|yaml)$/.test(base)) return true;
  if (/^docusaurus\.config\.(js|ts|mjs|cjs)$/.test(base)) return true;
  if (/^mkdocs\.(yml|yaml)$/.test(base)) return true;
  return false;
}

/** 单块的目标长度：再长就按声明边界切开，保证召回粒度够细 */
const CHUNK_TARGET = 1200;
/** 单块硬上限：即使找不到声明边界也必须切断，否则巨块会污染召回 */
const CHUNK_MAX = 2400;

/** 顶层声明起始行 —— 切块时优先从这里断开，避免把一个函数劈成两半 */
const DECL_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|func|fn|public|private|protected|impl|struct|trait|module|namespace|def|sub|object)\b/;

/** 文件价值打分：README 与配置文件优先，其余按深度衰减 */
function scoreFile(relPath: string): number {
  const lower = relPath.toLowerCase();
  const base = path.basename(lower);
  const depth = relPath.split('/').length;

  let score = 0;
  if (/^readme/.test(base)) score += 1000;
  if (/^(package|pyproject|go|cargo|pom|build\.gradle|composer|gemfile|requirements)/.test(base))
    score += 800;
  if (/^(tsconfig|jsconfig|next\.config|vite\.config|webpack|rollup|docker-compose|dockerfile|makefile)/.test(base))
    score += 700;
  if (/^(\.env\.example|\.env\.sample|\.env\.template)/.test(base)) score += 600;
  if (/^(index|main|app|server|cli|entry)\./.test(base)) score += 500;
  if (/^(docs?|contributing|architecture|changelog|api)\./.test(base)) score += 400;
  if (lower.includes('/src/') || lower.startsWith('src/')) score += 300;
  if (lower.includes('/test') || lower.includes('/spec')) score -= 200;

  return score - depth * 10;
}

async function walk(
  root: string,
  dir: string,
  out: string[],
  counter: { files: number },
  depth = 0,
): Promise<void> {
  if (counter.files >= limits.maxFiles) return;
  if (depth > MAX_WALK_DEPTH) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // 目录顺序在不同机器上不一致，会让同一仓库的索引内容漂移；
  // 排序后结果稳定，也便于复现检索问题
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (counter.files >= limits.maxFiles) return;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, full, out, counter, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;

    counter.files += 1;
    const ext = path.extname(entry.name).toLowerCase();
    if (SKIP_EXT.has(ext) || MINIFIED_RE.test(entry.name)) continue;
    if (SKIP_FILES.has(entry.name)) continue;

    const rel = path.relative(root, full).split(path.sep).join('/');
    if (isDocScaffolding(rel)) continue;

    out.push(rel);
  }
}

async function readTextFile(full: string): Promise<string | null> {
  let stat;
  try {
    stat = await fs.stat(full);
  } catch {
    return null;
  }
  if (stat.size === 0 || stat.size > limits.maxFileSizeBytes) return null;

  let buf: Buffer;
  try {
    buf = await fs.readFile(full);
  } catch {
    return null;
  }
  // 含空字节视为二进制
  if (buf.subarray(0, 4096).includes(0)) return null;

  return buf.toString('utf8');
}

/** 从一行声明里抠出符号名，用于给子块打标签 */
function symbolOf(line: string): string | null {
  const m = line.match(
    /(?:function|class|interface|type|enum|const|let|var|def|func|fn|struct|trait|impl|module|namespace)\s+([A-Za-z_$][\w$]*)/,
  );
  return m?.[1] ?? null;
}

/**
 * 把一个文件切成若干块。
 * 短文件整块保留；长文件按「顶层声明」边界切，尽量不劈开单个函数。
 */
export function chunkCode(relPath: string, text: string): SourceBlock[] {
  const category = categorize(relPath);
  const pathParts = relPath.split('/');

  if (text.length <= CHUNK_TARGET) {
    return [{ label: relPath, path: pathParts, text, category }];
  }

  const lines = text.split('\n');
  const blocks: SourceBlock[] = [];
  let buf: string[] = [];
  let size = 0;
  let anchor: string | null = null;
  let lineNo = 1;
  let blockStart = 1;

  const flush = () => {
    if (!buf.length) return;
    const body = buf.join('\n').trim();
    if (body) {
      const label = anchor ? `${relPath} › ${anchor}` : `${relPath} › L${blockStart}`;
      blocks.push({
        label,
        path: anchor ? [...pathParts, anchor] : pathParts,
        text: body,
        category,
      });
    }
    buf = [];
    size = 0;
    anchor = null;
    blockStart = lineNo;
  };

  for (const line of lines) {
    // 遇到新声明且当前块已经有内容，就在此处断开
    if (size >= CHUNK_TARGET && DECL_RE.test(line.trim())) flush();
    // 找不到声明边界时的硬切断
    if (size >= CHUNK_MAX) flush();

    buf.push(line);
    size += line.length + 1;
    if (!anchor && DECL_RE.test(line.trim())) anchor = symbolOf(line.trim());
    lineNo += 1;
  }
  flush();

  return blocks;
}

export async function loadRepo(rawUrl: string, trace?: TraceSink): Promise<LoadedSource> {
  const parsed = parseRepo(rawUrl);
  if (!parsed) {
    throw new ApiError(400, '无法从该 URL 解析出仓库地址，请使用形如 https://github.com/owner/repo 的链接');
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'socratic-repo-'));
  const cloneLimitSec = Math.round(limits.cloneTimeoutMs / 1000);

  try {
    emitTrace(
      trace,
      '克隆',
      `正在浅克隆 ${parsed.owner}/${parsed.repo}…（只取最新一次提交、不拉标签，超时上限 ${cloneLimitSec}s）`,
    );

    /*
     * 心跳只在有 sink 时启动 —— 没有 trace 时挂一个空转的定时器纯属浪费，
     * 而且会让「函数在无 sink 下行为完全一致」这条约定变得不成立。
     *
     * `git clone` 期间拿不到任何进度，而超时上限有 180s：不报点东西，
     * 用户无法判断是卡死了还是在下载。
     */
    const startedAt = Date.now();
    const heartbeat = trace
      ? setInterval(() => {
          const sec = Math.round((Date.now() - startedAt) / 1000);
          emitTrace(trace, '克隆', `仍在克隆…已等待 ${sec}s（大仓库会明显偏慢，超时上限 ${cloneLimitSec}s）。`);
        }, limits.cloneHeartbeatMs)
      : null;

    try {
      await run('git', ['clone', '--depth', '1', '--single-branch', '--no-tags', parsed.cloneUrl, workDir], {
        timeout: limits.cloneTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
        windowsHide: true,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
      if (e.code === 'ENOENT') {
        throw new ApiError(500, '服务器未安装 git，无法解析代码仓库');
      }
      if (e.killed) {
        throw new ApiError(504, `克隆仓库超时（${cloneLimitSec}s），仓库可能过大`);
      }
      const stderr = (e.stderr ?? '').toString();
      if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(stderr)) {
        throw new ApiError(422, '该仓库不存在或为私有仓库，无法访问');
      }
      if (/not found|repository .* does not exist|Repository not found/i.test(stderr)) {
        throw new ApiError(422, `仓库不存在：${parsed.owner}/${parsed.repo}`);
      }
      throw new ApiError(502, describeNetworkError(err, '克隆仓库'));
    } finally {
      // 必须在 catch 抛出之前停掉，否则定时器会在请求结束后继续往已关闭的流里写
      if (heartbeat) clearInterval(heartbeat);
    }

    emitTrace(trace, '克隆', `克隆完成（耗时 ${Math.round((Date.now() - startedAt) / 1000)}s），正在扫描文件树…`);

    const files: string[] = [];
    await walk(workDir, workDir, files, { files: 0 });

    if (files.length === 0) {
      throw new ApiError(422, '仓库中没有可分析的文本文件');
    }

    emitTrace(
      trace,
      '扫描',
      `扫描到 ${files.length} 个可索引的文本文件（已跳过依赖 / 产物 / 二进制 / 文档脚手架目录）。`,
    );

    files.sort((a, b) => scoreFile(b) - scoreFile(a));
    emitTrace(trace, '索引', '已按文件价值排序（README / 配置 / 入口文件优先），开始逐文件切块建索引…');

    const blocks: SourceBlock[] = [];
    let indexed = 0;
    let included = 0;
    let dropped = 0;
    const fileList: string[] = [];

    for (const rel of files) {
      if (indexed >= limits.indexBudgetChars) break;

      const raw = await readTextFile(path.join(workDir, rel));
      if (!raw) continue;

      const text =
        raw.length > limits.maxCharsPerFile
          ? `${raw.slice(0, limits.maxCharsPerFile)}\n…（本文件超出索引上限，已截断）`
          : raw;

      included += 1;
      fileList.push(rel);

      // 每个文件单独切块，保证块边界不会跨文件
      const fileBlocks = chunkCode(rel, text).filter((b) => {
        if (!isLowValueBlock(b.text)) return true;
        dropped += 1;
        return false;
      });
      for (const b of fileBlocks) {
        if (indexed >= limits.indexBudgetChars) break;
        blocks.push(b);
        indexed += b.text.length;
      }
    }

    emitTrace(
      trace,
      '索引',
      `纳入 ${included} / ${files.length} 个文件，切分为 ${blocks.length} 个语义块${
        dropped > 0 ? `（过滤掉 ${dropped} 个导航 / 名单类低价值块）` : ''
      }，共 ${indexed.toLocaleString('zh-CN')} 字。`,
    );

    const topLevel = await fs.readdir(workDir).catch(() => [] as string[]);
    const overview = topLevel.filter((n) => !SKIP_DIRS.has(n)).sort().join('  ');

    /**
     * 仓库清单单独作为一块：问「项目有哪些模块」时能命中。
     *
     * 但必须截断 —— 大仓库的文件列表可以到几万行，那会变成索引里最大的一块，
     * 而且形态上就是「目录页」，是检索污染的头号来源（正是 isLowValueBlock 要拦的东西）。
     * 只留前 N 条，足够回答「有哪些模块」，又不至于霸榜。
     */
    const MAX_MANIFEST_FILES = 400;
    const listed = fileList.slice(0, MAX_MANIFEST_FILES);
    const omitted = fileList.length - listed.length;

    const manifest: SourceBlock = {
      label: '仓库清单',
      path: ['仓库清单'],
      category: 'meta',
      text: [
        `# 代码仓库：${parsed.owner}/${parsed.repo}`,
        `源地址：${rawUrl}`,
        `顶层条目：${overview}`,
        `纳入索引的文件：${included} / 扫描到 ${files.length} 个文本文件`,
        `索引块数：${blocks.length}${dropped > 0 ? `（另有 ${dropped} 个导航/名单类低价值块已过滤）` : ''}`,
        '',
        '## 文件列表',
        listed.join('\n'),
        omitted > 0 ? `…（另有 ${omitted} 个文件未列出）` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };

    const allBlocks = [manifest, ...blocks];

    return {
      kind: 'repo',
      title: `${parsed.owner}/${parsed.repo}`,
      summary: `已克隆并解析该代码仓库，扫描到 ${files.length} 个文本文件，其中 ${included} 个进入检索索引（${allBlocks.length} 个语义块${
        dropped > 0 ? `，已过滤 ${dropped} 个导航/名单类低价值块` : ''
      }）。`,
      content: allBlocks.map((b) => `\n## ${b.label}\n\`\`\`\n${b.text}\n\`\`\`\n`).join(''),
      blocks: allBlocks,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
