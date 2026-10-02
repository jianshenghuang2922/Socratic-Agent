'use client';

import { useState } from 'react';

interface Props {
  loading: boolean;
  error?: string;
  onSubmit: (url: string) => void;
}

const SAMPLES = [
  { label: 'nextjs.org/docs/app', url: 'https://nextjs.org/docs/app' },
  { label: '维基百科 · 苏格拉底', url: 'https://zh.wikipedia.org/wiki/苏格拉底' },
  { label: 'github.com/vercel/next.js', url: 'https://github.com/vercel/next.js' },
];

function normalize(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProto);
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** URL 输入区：首次进入页面时展示，提交后建立问答上下文 */
export function UrlGate({ loading, error, onSubmit }: Props) {
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState('');

  const submit = () => {
    const url = normalize(value);
    if (!url) {
      setLocalError('请输入有效的 URL，例如 https://example.com/article');
      return;
    }
    setLocalError('');
    onSubmit(url);
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-badge">V1.1</div>
        <h1 className="gate-title">基于 URL 的智能问答 Agent</h1>
        <p className="gate-sub">
          输入一个<strong>网页</strong>或<strong>代码仓库</strong>的 URL，我会读取它的内容并建立问答上下文。
          之后你可以直接提问，也可以让我基于内容出题考你。
        </p>

        <div className="gate-form">
          <input
            type="text"
            className="gate-input"
            placeholder="https://example.com/article 或 https://github.com/user/repo"
            value={value}
            disabled={loading}
            autoFocus
            onChange={(e) => {
              setValue(e.target.value);
              setLocalError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <button type="button" className="btn btn--primary btn--lg" disabled={loading} onClick={submit}>
            {loading ? '解析中…' : '开始问答'}
          </button>
        </div>

        {(localError || error) && <div className="gate-error">{localError || error}</div>}

        <div className="gate-samples">
          <span className="gate-samples-label">试试：</span>
          {SAMPLES.map((s) => (
            <button
              key={s.url}
              type="button"
              className="chip"
              disabled={loading}
              onClick={() => setValue(s.url)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
