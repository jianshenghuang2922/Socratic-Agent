'use client';

import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { ChoiceCard } from './ChoiceCard';
import { ShortCard } from './ShortCard';
import { ThinkingPanel } from './ThinkingPanel';
import type { ChatMessage, ChatMode, QuestionType, TraceEvent } from '@/lib/types';

interface Props {
  messages: ChatMessage[];
  mode: ChatMode;
  questionType: QuestionType;
  busy: boolean;
  /** 当前动作的实时思考轨迹 —— 只在不忙之前的等待期间非空 */
  liveTrace: TraceEvent[];
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
  liveTrace,
  onChoiceSubmit,
  onShortSubmit,
  onHint,
  onNextQuestion,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  // 轨迹也要参与滚动触发：它是「正在变化的内容」，不跟着滚用户就看不到最新一步
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy, liveTrace]);

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
                {/* 出题过程：折叠成一行，点开能回看「这题是怎么来的」 */}
                <ThinkingPanel steps={m.trace ?? []} />
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

      {/*
        等待占位：优先显示思考过程，没有轨迹时才退回三点动画。
        轨迹不可能永远有（如一次性接口的退路、初始化阶段），
        所以那个三点指示器不能直接删掉 —— 否则这些场景下页面会是彻底静止的。
      */}
      {busy && (
        <div className="row row--agent">
          <div className="avatar avatar--agent">AI</div>
          <div className="bubble-group bubble-group--wide">
            {liveTrace.length > 0 ? (
              <ThinkingPanel steps={liveTrace} live />
            ) : (
              <div className="bubble bubble--agent">
                <span className="typing">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
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
