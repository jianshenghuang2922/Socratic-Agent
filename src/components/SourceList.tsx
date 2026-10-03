'use client';

import { useState } from 'react';

interface Props {
  /** 资料块标签，形如 `lib/core/Axios.js › interceptor` */
  sources?: string[];
  /** 收起状态下最多展示几个 */
  visible?: number;
}

/** 把 `路径 › 符号` 拆开，路径部分用等宽字体，更像「出处」而不是一句描述 */
function split(label: string): { path: string; anchor: string | null } {
  const i = label.indexOf('›');
  if (i < 0) return { path: label.trim(), anchor: null };
  return { path: label.slice(0, i).trim(), anchor: label.slice(i + 1).trim() || null };
}

/**
 * 引用来源 —— RAG 的可信度就靠它。
 *
 * 回答和出题都基于召回的资料，把资料出处摆出来，用户才能判断
 * 「这个回答是有据可查，还是模型自己在编」。
 * 默认只露出前几个，避免一大串路径把对话区淹掉。
 */
export function SourceList({ sources, visible = 3 }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!sources || sources.length === 0) return null;

  // 去重：同一份资料可能在多轮召回里重复出现
  const unique = [...new Set(sources)];
  const shown = expanded ? unique : unique.slice(0, visible);
  const rest = unique.length - shown.length;

  return (
    <div className="sources">
      <div className="sources-head">
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path
            d="M10.6 13.4a3 3 0 0 0 4.24 0l2.83-2.83a3 3 0 0 0-4.24-4.24l-1.42 1.41"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
          <path
            d="M13.4 10.6a3 3 0 0 0-4.24 0l-2.83 2.83a3 3 0 0 0 4.24 4.24l1.42-1.41"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </svg>
        <span>依据 {unique.length} 处资料</span>
      </div>

      <div className="sources-list">
        {shown.map((s) => {
          const { path, anchor } = split(s);
          return (
            <span key={s} className="source-chip" title={s}>
              <span className="source-chip__path">{path}</span>
              {anchor && <span className="source-chip__anchor">› {anchor}</span>}
            </span>
          );
        })}

        {rest > 0 && (
          <button type="button" className="source-more" onClick={() => setExpanded(true)}>
            +{rest} 更多
          </button>
        )}
        {expanded && unique.length > visible && (
          <button type="button" className="source-more" onClick={() => setExpanded(false)}>
            收起
          </button>
        )}
      </div>
    </div>
  );
}
