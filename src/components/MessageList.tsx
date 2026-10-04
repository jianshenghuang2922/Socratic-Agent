'use client';

import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { ChoiceCard } from './ChoiceCard';
import { ShortCard } from './ShortCard';
import type { ChatMessage, ChatMode, QuestionType } from '@/lib/types';

interface Props {
  messages: ChatMessage[];
  mode: ChatMode;
  questionType: QuestionType;
  busy: boolean;
  onChoiceSubmit: (messageId: string, index: number) => void;
  onShortSubmit: (messageId: string, answer: string) => void;
  onHint: (messageId: string) => void;
  onNextQuestion: () => void;
}

export function MessageList({
  messages,
  mode,
  questionType,
  busy,
  onChoiceSubmit,
  onShortSubmit,
  onHint,
  onNextQuestion,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  // 最后一条题目是否已结束（已作答，或因题型切换被作废）—— 决定是否展示「下一题」
  const lastQuestion = [...messages].reverse().find((m) => m.kind === 'question');
  const showNext =
    mode === 'answer' &&
    !!lastQuestion &&
    lastQuestion.kind === 'question' &&
    (lastQuestion.question.submitted === true || lastQuestion.question.abandoned === true) &&
    !busy;

  return (
    <div className="messages">
      {messages.map((m) => {
        if (m.kind === 'notice') {
          return (
            <div key={m.id} className="notice">
              {m.content}
            </div>
          );
        }
        if (m.kind === 'question') {
          return (
            <div key={m.id} className="row row--agent">
              <div className="avatar avatar--agent">AI</div>
              <div className="bubble-group bubble-group--wide">
                <div className="bubble-meta">Agent</div>
                {m.question.type === 'choice' ? (
                  <ChoiceCard
                    question={m.question}
                    disabled={busy}
                    onSubmit={(i) => onChoiceSubmit(m.id, i)}
                    onHint={() => onHint(m.id)}
                  />
                ) : (
                  <ShortCard
                    question={m.question}
                    disabled={busy}
                    onSubmit={(a) => onShortSubmit(m.id, a)}
                    onHint={() => onHint(m.id)}
                  />
                )}
              </div>
            </div>
          );
        }
        return <MessageBubble key={m.id} message={m} />;
      })}

      {busy && (
        <div className="row row--agent">
          <div className="avatar avatar--agent">AI</div>
          <div className="bubble-group">
            <div className="bubble bubble--agent">
              <span className="typing">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        </div>
      )}

      {showNext && (
        <div className="next-row">
          <button type="button" className="btn btn--ghost" onClick={onNextQuestion}>
            下一题 · {questionType === 'choice' ? '选择题' : '简答题'}
          </button>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
