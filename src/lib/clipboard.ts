/**
 * 复制到剪贴板。
 *
 * 为什么不能直接 `navigator.clipboard.writeText`：它在两种很常见的场景下会 reject ——
 *   1. **非安全上下文**。`navigator.clipboard` 只在 https / localhost 下存在，
 *      有人把服务跑在局域网 http 上分享给同事时，它直接是 undefined；
 *   2. **文档未聚焦**（iframe、切走标签页、部分无头环境）。
 * 这两种情况下直接弹 `window.prompt` 让用户手动复制，体验上等于「复制功能坏了」。
 *
 * `document.execCommand('copy')` 虽然被标记废弃，但它恰恰是上面两种场景里
 * 唯一还能用的路子 —— 所以留作第二层。两层都失败才交还给调用方去提示用户。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下一层 */
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // 必须在视口内才能选中；挪出屏幕而不是 display:none，后者选不中
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
