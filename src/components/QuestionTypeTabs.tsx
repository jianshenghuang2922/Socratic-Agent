'use client';

import type { QuestionType } from '@/lib/types';

interface Props {
  /** null = 尚未选定题型（切到回答模式后、用户点击之前），此时两个选项都不高亮 */
  value: QuestionType | null;
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
    <div
      className={`segmented ${value === null ? 'segmented--pick' : ''}`}
      role="tablist"
      aria-label="题型"
    >
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
