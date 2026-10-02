/**
 * 检索用的结构化块。
 *
 * RAG 的效果上限主要由切块质量决定 —— 比换检索算法重要得多。
 * 所以每个块都带「它是哪儿来的」：文件路径 / 标题层级 / 符号名。
 * 检索时对 label 加权，用户问 dispatchRequest 时能直接命中同名文件，
 * 而不是靠正文里的偶然词频。
 */
export interface SourceBlock {
  /** 人类可读的来源标识，会随块一起注入 prompt，如 `lib/core/Axios.js` */
  label: string;
  /** 层级路径，如 ['src/core', 'Axios.js', 'dispatchRequest']，供加权与展示 */
  path: string[];
  /** 块的正文 */
  text: string;
  /** 块类型：代码 / 文档 / 配置 / 清单，便于按类型加权 */
  category: 'code' | 'doc' | 'config' | 'meta';
}

/** 解析后的 URL 内容源 */
export interface LoadedSource {
  kind: 'web' | 'repo';
  /** 展示用标题 */
  title: string;
  /** 建立上下文后回给前端的一句话说明 */
  summary: string;
  /**
   * 拼好的纯文本全文。
   * 保留它是为了兜底：检索失败时可以直接截一段给模型，
   * 也方便「无查询词」的滚动取窗口场景。
   */
  content: string;
  /** 结构化块 —— 检索的真正数据源 */
  blocks: SourceBlock[];
}

/** 按扩展名推断块类型 */
export function categorize(pathOrName: string): SourceBlock['category'] {
  const name = pathOrName.toLowerCase();
  if (/(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|composer\.json|requirements\.txt|gemfile|dockerfile|docker-compose|makefile|\.env\.example|\.env\.sample|tsconfig|jsconfig|vite\.config|webpack|rollup|next\.config)/.test(name)) {
    return 'config';
  }
  if (/\.(md|mdx|rst|txt|adoc)$/.test(name) || /(^|\/)(readme|changelog|contributing|license|authors)/.test(name)) {
    return 'doc';
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|rb|php|cs|c|cpp|h|hpp|swift|scala|sh|bash|sql|lua|dart|ex|exs|erl|clj|hs|ml|r|jl|pl)$/.test(name)) {
    return 'code';
  }
  return 'meta';
}

/**
 * 判定「低价值块」—— 导航、赞助商名单、目录页这类内容。
 *
 * 为什么必须过滤：这类块由成百上千条短行组成，几乎涵盖项目里出现过的所有名词。
 * 任何中文查询都能在上面部分命中，于是它们在检索里稳定霸榜，
 * 把真正的代码块挤下去。实测 axios 仓库上，`docs/.vitepress/config.mts › zhNav`
 * 在 8 个不相关查询里 7 次排进前三 —— 这就是典型的「垃圾块污染召回」。
 *
 * 判据：短行占比过高、或链接占比过高，且看起来不像代码。
 */
export function isLowValueBlock(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 6) return false;

  // 看起来是代码就保留，代码本来就有很多短行
  const codeish = lines.filter((l) => /[{};=()[\]]/.test(l)).length;
  const looksLikeCode = codeish / lines.length > 0.5;

  // 规则一：短行占比过高 —— 目录页、列表页
  const short = lines.filter((l) => l.length < 24).length;
  if (!looksLikeCode && short / lines.length > 0.75) return true;

  // 规则二：链接占比过高 —— 友链、赞助商
  const urls = lines.filter((l) => /https?:\/\//.test(l)).length;
  if (!looksLikeCode && urls / lines.length > 0.35) return true;

  /**
   * 规则三：满屏短中文引号串 —— 导航菜单、多语言对照表。
   *
   * 这条专门针对 VitePress/Docusaurus 的 config 文件：
   * 它们由 `{ text: '指南', link: '/zh/guide' }` 这类行组成，
   * 含 `{}` 所以「看起来是代码」，但它其实是整个站点的中文标题清单，
   * 任何中文查询都能在上面部分命中，是污染召回的头号来源。
   *
   * 之所以要求引号串里含中文，是为了不误伤 package.json —— 它同样满是引号，
   * 但内容是 ASCII 且有真实价值。
   */
  const cjkQuotedLines = lines.filter((l) => {
    const quoted = l.match(/['"`][^'"`\n]{1,30}['"`]/g) ?? [];
    return quoted.some((s) => /[\u4e00-\u9fff]/.test(s));
  }).length;
  if (cjkQuotedLines / lines.length > 0.4) return true;

  return false;
}
