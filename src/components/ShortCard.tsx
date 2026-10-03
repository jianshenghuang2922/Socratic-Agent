'use client';

import { useState } from 'react';
import { SourceList } from './SourceList';
import type { ShortQuestion } from '@/lib/types';

interface Props {
  question: ShortQuestion;
  disabled?: boolean;
  onSubmit: (answer: string) => void;
}

const VERDICT_TEXT = {
  correct: '✓ 回答正确',
  partial: '◐ 部分正确',
  incorrect: '✕ 回答错误',
} as const;

/** 简答题卡片：多行文本输入，提交后给出判定、反馈与参考答案 */
export function ShortCard({ question, disabled, onSubmit }: Props) {
  const [draft, setDraft] = useState('');
  const submitted = question.submitted === true;
  const abandoned = question.abandoned === true;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 提交，Shift + Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (draft.trim() && !disabled) onSubmit(draft.trim());
    }
  };

  return (
    <div className={`card ${abandoned ? 'card--abandoned' : ''}`}>
      <div className="card-tag card-tag--short">简答题</div>
      <p className="card-prompt">{question.prompt}</p>

      <SourceList sources={question.sources} visible={2} />

      {abandoned && <div className="card-abandoned">此题已作废（题型已切换）</div>}

      {!submitted && !abandoned ? (
        <>
          <textarea
            className="short-input"
            rows={4}
            placeholder="在此作答，Enter 提交，Shift + Enter 换行"
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="card-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!draft.trim() || disabled}
              onClick={() => onSubmit(draft.trim())}
            >
              提交答案
            </button>
          </div>
        </>
      ) : abandoned ? null : (
        <div className="card-result">
          <div className="answer-echo">
            <span className="explain-label">我的作答</span>
            {question.answer}
          </div>
          <div className={`verdict ${verdictClass(question.verdict)}`}>
            {VERDICT_TEXT[question.verdict ?? 'incorrect']}
          </div>
          {question.feedback && (
            <div className="explain">
              <span className="explain-label">反馈</span>
              {question.feedback}
            </div>
          )}
          {question.reference && (
            <div className="explain explain--ref">
              <span className="explain-label">参考答案</span>
              {question.reference}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function verdictClass(v: ShortQuestion['verdict']) {
  if (v === 'correct') return 'verdict--ok';
  if (v === 'partial') return 'verdict--mid';
  return 'verdict--bad';
}
