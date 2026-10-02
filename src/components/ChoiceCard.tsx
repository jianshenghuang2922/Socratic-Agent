'use client';

import { useState } from 'react';
import type { ChoiceQuestion } from '@/lib/types';

interface Props {
  question: ChoiceQuestion;
  disabled?: boolean;
  onSubmit: (selectedIndex: number) => void;
}

/** 选择题卡片：单选按钮式选项，提交后揭示正确答案与解析 */
export function ChoiceCard({ question, disabled, onSubmit }: Props) {
  const [picked, setPicked] = useState<number | null>(question.selectedIndex ?? null);
  const submitted = question.submitted === true;
  const abandoned = question.abandoned === true;

  const optionClass = (i: number) => {
    const cls = ['option'];
    if (submitted) {
      if (i === question.correctIndex) cls.push('option--correct');
      else if (i === question.selectedIndex) cls.push('option--wrong');
      cls.push('option--locked');
      return cls.join(' ');
    }
    if (abandoned) {
      cls.push('option--locked');
      return cls.join(' ');
    }
    if (picked === i) cls.push('option--picked');
    return cls.join(' ');
  };

  return (
    <div className={`card ${abandoned ? 'card--abandoned' : ''}`}>
      <div className="card-tag">选择题</div>
      <p className="card-prompt">{question.prompt}</p>

      {abandoned && <div className="card-abandoned">此题已作废（题型已切换）</div>}

      <div className="options" role="radiogroup">
        {question.options.map((opt, i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={picked === i}
            className={optionClass(i)}
            disabled={submitted || abandoned || disabled}
            onClick={() => setPicked(i)}
          >
            <span className="option-key">{String.fromCharCode(65 + i)}</span>
            <span className="option-text">{opt}</span>
            {submitted && i === question.correctIndex && <span className="option-mark">✓</span>}
            {submitted && i === question.selectedIndex && i !== question.correctIndex && (
              <span className="option-mark option-mark--wrong">✕</span>
            )}
          </button>
        ))}
      </div>

      {!submitted && !abandoned && (
        <div className="card-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={picked === null || disabled}
            onClick={() => picked !== null && onSubmit(picked)}
          >
            提交答案
          </button>
        </div>
      )}

      {submitted && (
        <div className="card-result">
          <div className={`verdict ${verdictClass(question)}`}>
            {question.selectedIndex === question.correctIndex ? '✓ 回答正确' : '✕ 回答错误'}
            <span className="verdict-sub">
              正确答案：{String.fromCharCode(65 + (question.correctIndex ?? 0))}
            </span>
          </div>
          {question.explanation && (
            <div className="explain">
              <span className="explain-label">解析</span>
              {question.explanation}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function verdictClass(q: ChoiceQuestion) {
  return q.selectedIndex === q.correctIndex ? 'verdict--ok' : 'verdict--bad';
}
