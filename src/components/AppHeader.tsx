'use client';

import type { AgentMode } from '@/lib/agent';
import { maskKey, type LlmSettings } from '@/lib/llmSettings';
import type { ServerLlmInfo } from '@/hooks/useLlmSettings';
import type { TrialQuota } from '@/lib/trial';
import type { StatusState, UrlContext } from '@/lib/types';
import { StatusBar } from './StatusBar';

interface Props {
  context: UrlContext | null;
  status: StatusState;
  busy: boolean;
  agentMode: AgentMode;
  settings: LlmSettings | null;
  serverInfo: ServerLlmInfo | null;
  /** 实时免费额度（来自外部 store，比 serverInfo 里那份更新鲜） */
  trial: TrialQuota | null;
  onOpenSettings: () => void;
  onReset: () => void;
}

/**
 * 凭据状态徽标。
 * 存在的意义是「一眼看出这个页面到底在用什么在回答」——
 * 之前线上跑的是前端联调模拟，界面上却完全看不出来。
 *
 * 现在多担一件事：让免费额度**一直可见**。额度在会话中途用尽时，
 * 入口那张卡片已经不在屏幕上了，这个徽标是用户唯一能看到的提醒。
 */
function LlmBadge({
  agentMode,
  settings,
  serverInfo,
  trial,
  onClick,
}: {
  agentMode: AgentMode;
  settings: LlmSettings | null;
  serverInfo: ServerLlmInfo | null;
  trial: TrialQuota | null;
  onClick: () => void;
}) {
  let tone = 'warn';
  let text = '模型未配置';

  if (agentMode === 'mock') {
    tone = 'warn';
    text = '模拟模式';
  } else if (settings) {
    tone = 'ok';
    text = `自带 Key ${maskKey(settings.apiKey)}`;
  } else if (serverInfo?.llmConfigured) {
    if (trial?.available) {
      if (trial.remaining > 0) {
        tone = 'ok';
        text = `免费额度 ${trial.remaining} 次`;
      } else {
        tone = 'warn';
        text = '额度已用完';
      }
    } else {
      tone = 'ok';
      text = '服务端 Key';
    }
  } else if (serverInfo) {
    tone = 'warn';
    text = '未配置 Key';
  } else {
    tone = 'idle';
    text = '模型设置';
  }

  const title =
    !settings && trial?.available
      ? `免费额度剩余 ${trial.remaining} 次；点这里可以换成你自己的 API Key，不再受限`
      : '配置你自己的 API Key';

  return (
    <button type="button" className={`llm-badge llm-badge--${tone}`} onClick={onClick} title={title}>
      <span className="llm-badge__dot" />
      <span className="llm-badge__text">{text}</span>
      <span className="llm-badge__gear">设置</span>
    </button>
  );
}

/** 顶部栏：品牌 + 当前 URL + 模型设置入口 + 状态提示区 */
export function AppHeader({
  context,
  status,
  busy,
  agentMode,
  settings,
  serverInfo,
  trial,
  onOpenSettings,
  onReset,
}: Props) {
  return (
    <header className="header">
      <div className="header-left">
        <div className="logo">S</div>
        <div className="header-titles">
          <div className="header-title">Socratic Agent</div>
          <div className="header-sub">读网页与仓库，出题考你</div>
        </div>
      </div>

      <div className="header-right">
        {context && (
          <>
            <a
              className="url-chip"
              href={context.url}
              target="_blank"
              rel="noreferrer noopener"
              title={context.url}
            >
              <span className="url-dot" />
              {context.title}
            </a>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onReset}>
              重新输入 URL
            </button>
          </>
        )}
        <LlmBadge
          agentMode={agentMode}
          settings={settings}
          serverInfo={serverInfo}
          trial={trial}
          onClick={onOpenSettings}
        />
        <StatusBar status={status} />
      </div>
    </header>
  );
}
