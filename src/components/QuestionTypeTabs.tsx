'use client';

import type { QuestionType } from '@/lib/types';

interface Props {
  value: QuestionType;
  onChange: (type: QuestionType) => void;
  disabled?: boolean;
}

const TYPES: { key: QuestionType; label: string }[] = [
  { key: 'choice', label: '选择题' },
  { key: 'short', label: '简答题' },
];

/** 题型选择区：仅在回答模式下出现 */
export function QuestionTypeTabs({ value, onChange, disabled }: Props) {
  return (
    <div className="segmented" role="tablist" aria-label="题型">
      {TYPES.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          className={`segment ${value === t.key ? 'segment--active' : ''}`}
          disabled={disabled}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
