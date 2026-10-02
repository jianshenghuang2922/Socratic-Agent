'use client';

import type { StatusState, UrlContext } from '@/lib/types';
import { StatusBar } from './StatusBar';

interface Props {
  context: UrlContext | null;
  status: StatusState;
  busy: boolean;
  onReset: () => void;
}

/** 顶部栏：品牌 + 当前 URL + 重新输入入口 + 状态提示区 */
export function AppHeader({ context, status, busy, onReset }: Props) {
  return (
    <header className="header">
      <div className="header-left">
        <div className="logo">S</div>
        <div className="header-titles">
          <div className="header-title">Socratic Agent</div>
          <div className="header-sub">基于 URL 内容的问答助手</div>
        </div>
      </div>

      <div className="header-right">
        {context && (
          <>
            <a
              className="url-chip"
              href={context.url}
              target="_blank"
              rel="noreferrer noopener"
              title={context.url}
            >
              <span className="url-dot" />
              {context.title}
            </a>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onReset}>
              重新输入 URL
            </button>
          </>
        )}
        <StatusBar status={status} />
      </div>
    </header>
  );
}
