'use client';

import { useEffect } from 'react';

/**
 * 全局错误边界 —— 兜住根 layout 自身的崩溃。
 *
 * 这是最后一道防线：它渲染时 <html>/<body> 已经失效，所以必须自带完整骨架，
 * 且只能用内联样式（此时全局 CSS 可能没加载成功）。
 * 页面级错误交给同目录的 error.tsx，不要在这里处理常规异常。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global error]', error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#05070f',
          color: '#eaf0ff',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 460,
            width: '100%',
            padding: '28px 26px',
            borderRadius: 18,
            background: 'rgba(17, 23, 44, 0.72)',
            border: '1px solid rgba(255, 255, 255, 0.10)',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 30, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ margin: '0 0 10px', fontSize: 19, fontWeight: 600 }}>应用加载失败</h1>
          <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.7, color: '#b4bfdd' }}>
            页面遇到无法恢复的错误，需要重新加载。
            {error.digest && (
              <>
                <br />
                <span style={{ fontSize: 12, color: '#7b87a8' }}>错误编号：{error.digest}</span>
              </>
            )}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              type="button"
              onClick={reset}
              style={{
                padding: '9px 20px',
                fontSize: 14,
                fontFamily: 'inherit',
                color: '#fff',
                background: 'linear-gradient(140deg, #5b8cff, #38bdf8)',
                border: '1px solid rgba(255,255,255,0.22)',
                borderRadius: 10,
                cursor: 'pointer',
              }}
            >
              重试
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: '9px 20px',
                fontSize: 14,
                fontFamily: 'inherit',
                color: '#eaf0ff',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.17)',
                borderRadius: 10,
                cursor: 'pointer',
              }}
            >
              重新加载
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
