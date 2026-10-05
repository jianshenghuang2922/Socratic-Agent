'use client';

import { useState } from 'react';
import type { TraceEvent } from '@/lib/types';

interface Props {
  steps: TraceEvent[];
  /** 执行中：必须展开、且不提供收起（收起等于把「正在做什么」藏起来，就白做了） */
  live?: boolean;
}

/**
 * 思考过程面板 —— 用户等待 Agent 时看到的东西。
 *
 * 两种形态：
 *  · 执行中（live）：面板常开后逐步追加，最后一条高亮为「此刻正在做的事」。
 *    原实现这里是一个三点跳动的 typing 气泡，转十几秒什么信息都不给。
 *  · 已结束：折叠成一行摘要，点开可回看完整过程。
 *    不折叠的话，聊几轮之后满屏都是跑完的思考过程，把真正要看的回答挤走。
 *
 * 内容来自服务端逐步下发的 trace 事件，讲的是管道里真实发生的事
 * （查询扩展映射出了什么、召回了哪些块、出题自检为什么没过），
 * 不是模型编的「让我想想…」。
 */
export function ThinkingPanel({ steps, live = false }: Props) {
  const [open, setOpen] = useState(false);

  if (steps.length === 0) return null;

  if (!live) {
    return (
      <div className="trace-wrap">
        <button
          type="button"
          className="trace-summary"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`trace-caret`}>{open ? '▾' : '▸'}</span>
          <span>查看思考过程 · {steps.length} 步</span>
        </button>
        {open && <TraceBody steps={steps} />}
      </div>
    );
  }

  return <TraceBody steps={steps} live />;
}

function TraceBody({ steps, live = false }: { steps: TraceEvent[]; live?: boolean }) {
  return (
    <div className={`trace ${live ? 'trace--live' : ''}`}>
      <div className="trace-head">
        <span className="trace-dot" />
        <span>{live ? 'Agent 思考中' : '思考过程'}</span>
        {live && <span className="trace-count">{steps.length} 步</span>}
      </div>
      <ol className="trace-steps">
        {steps.map((s, i) => (
          <li
            key={`${i}-${s.detail.slice(0, 12)}`}
            className={`trace-step ${i === steps.length - 1 ? 'trace-step--last' : ''}`}
          >
            <span className="trace-stage">{s.stage}</span>
            {s.detail}
          </li>
        ))}
      </ol>
    </div>
  );
}
