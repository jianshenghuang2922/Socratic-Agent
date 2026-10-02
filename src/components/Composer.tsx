'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
}

/** 输入交互区：Enter 发送，Shift + Enter 换行，输入框随内容自适应高度 */
export function Composer({ disabled, placeholder, onSend }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      <div className={`composer-box ${disabled ? 'composer-box--disabled' : ''}`}>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder ?? '输入你的问题…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="send-btn"
          disabled={disabled || !text.trim()}
          onClick={send}
          aria-label="发送"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
      <div className="composer-hint">Enter 发送 · Shift + Enter 换行</div>
    </div>
  );
}
