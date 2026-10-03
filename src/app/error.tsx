'use client';

import { useEffect } from 'react';

/**
 * 页面级错误边界。
 *
 * 没有它的话，任何一处渲染期异常（比如消息数据不符合预期）
 * 都会让用户看到一片白屏，既不知道发生了什么，也没有恢复路径。
 *
 * 这里可以复用全局样式，因为 layout 仍然存活。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app error]', error);
  }, [error]);

  // 会话过期是最高频的可恢复错误，单独给一句更准的提示
  const text = (error.message ?? '').toString();
  const expired = /会话|过期|上下文/.test(text);

  return (
    <div className="error-page">
      <div className="error-card">
        <div className="error-icon">⚠️</div>
        <h1 className="error-title">{expired ? '会话已失效' : '出了点问题'}</h1>
        <p className="error-desc">
          {expired
            ? '当前会话的上下文已过期（服务端重启或闲置过久都会导致）。重新解析一次 URL 即可继续。'
            : '页面在渲染时遇到了错误，你可以重试；如果反复出现，请重新解析 URL 建立上下文。'}
        </p>

        {error.message && <div className="error-detail">{error.message}</div>}

        <div className="error-actions">
          <button type="button" className="btn btn--primary" onClick={reset}>
            重试
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => window.location.reload()}
          >
            回到首页
          </button>
        </div>
      </div>
    </div>
  );
}
