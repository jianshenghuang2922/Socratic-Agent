'use client';

import type { StatusState } from '@/lib/types';

const DOT: Record<StatusState['kind'], string> = {
  idle: 'dot--idle',
  loading: 'dot--busy',
  thinking: 'dot--busy',
  success: 'dot--ok',
  error: 'dot--error',
};

/** 状态提示区：展示 URL 加载、Agent 思考、回答完成等状态 */
export function StatusBar({ status }: { status: StatusState }) {
  if (!status.text) {
    return (
      <div className="status status--idle">
        <span className="dot dot--idle" />
        就绪
      </div>
    );
  }
  return (
    <div className={`status status--${status.kind}`} role="status" aria-live="polite">
      <span className={`dot ${DOT[status.kind]}`} />
      {status.text}
    </div>
  );
}
