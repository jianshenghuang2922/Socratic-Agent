/** 已知的代码托管站点。前后端共用同一套判定，避免 Mock 与真实后端行为不一致。 */
export const CODE_HOSTS = [
  'github.com',
  'gitlab.com',
  'gitee.com',
  'bitbucket.org',
  'codeberg.org',
  'gitcode.com',
  'coding.net',
];

/** 判断 URL 是否指向代码仓库 */
export function isRepoUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return CODE_HOSTS.includes(host);
  } catch {
    return false;
  }
}

/** 从仓库 URL 解析出 owner/repo */
export function parseRepo(url: string): { owner: string; repo: string; cloneUrl: string } | null {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const owner = decodeURIComponent(segments[0]);
    const repo = decodeURIComponent(segments[1]).replace(/\.git$/i, '');
    if (!owner || !repo) return null;
    return {
      owner,
      repo,
      cloneUrl: `${u.protocol}//${u.hostname}/${owner}/${repo}.git`,
    };
  } catch {
    return null;
  }
}
