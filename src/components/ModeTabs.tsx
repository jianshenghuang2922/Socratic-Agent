'use client';

import type { ChatMode } from '@/lib/types';

interface Props {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
  disabled?: boolean;
}

const TABS: { key: ChatMode; label: string; desc: string }[] = [
  { key: 'ask', label: '提问模式', desc: '用户 → Agent' },
  { key: 'answer', label: '回答模式', desc: 'Agent → 用户' },
];

/** 模式选择区：提问模式 / 回答模式 */
export function ModeTabs({ mode, onChange, disabled }: Props) {
  return (
    <div className="tabs" role="tablist" aria-label="交互模式">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={mode === t.key}
          className={`tab ${mode === t.key ? 'tab--active' : ''}`}
          disabled={disabled}
          onClick={() => onChange(t.key)}
        >
          <span className="tab-label">{t.label}</span>
          <span className="tab-desc">{t.desc}</span>
        </button>
      ))}
    </div>
  );
}
