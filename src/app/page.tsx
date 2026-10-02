'use client';

import { AppHeader } from '@/components/AppHeader';
import { Composer } from '@/components/Composer';
import { MessageList } from '@/components/MessageList';
import { ModeTabs } from '@/components/ModeTabs';
import { QuestionTypeTabs } from '@/components/QuestionTypeTabs';
import { ScorePanel } from '@/components/ScorePanel';
import { UrlGate } from '@/components/UrlGate';
import { useQASession } from '@/hooks/useQASession';

export default function Page() {
  const s = useQASession();

  return (
    <div className="app">
      <AppHeader
        context={s.context}
        status={s.status}
        busy={s.busy}
        onReset={s.resetSession}
      />

      {s.phase === 'idle' ? (
        <main className="app-main app-main--gate">
          <UrlGate
            loading={false}
            error={s.status.kind === 'error' ? s.status.text : undefined}
            onSubmit={s.initSession}
          />
        </main>
      ) : s.phase === 'initializing' ? (
        <main className="app-main app-main--gate">
          <div className="gate">
            <div className="gate-card gate-card--loading">
              <div className="spinner" />
              <h2 className="gate-title">正在解析 URL 内容…</h2>
              <p className="gate-sub">
                正在读取目标内容、切分语义段落并建立可检索的问答上下文。
                网页与代码仓库均可。
              </p>
            </div>
          </div>
        </main>
      ) : (
        <>
          <div className="control-bar">
            <ModeTabs mode={s.mode} onChange={s.changeMode} disabled={s.busy} />
            {s.mode === 'answer' && (
              <QuestionTypeTabs
                value={s.questionType}
                onChange={s.changeQuestionType}
                disabled={s.busy}
              />
            )}
            <ScorePanel
              score={s.score}
              questionCount={s.questionCount}
              pulsing={s.pulsing}
            />
          </div>

          <main className="app-main">
            <MessageList
              messages={s.messages}
              mode={s.mode}
              questionType={s.questionType}
              busy={s.busy}
              onChoiceSubmit={s.submitChoice}
              onShortSubmit={s.submitShort}
              onNextQuestion={() => s.requestNextQuestion()}
            />
          </main>

          {s.mode === 'ask' ? (
            <Composer
              disabled={s.busy}
              placeholder="针对该 URL 的内容提问…"
              onSend={s.sendAsk}
            />
          ) : (
            <div className="composer composer--locked">
              <div className="locked-hint">
                回答模式下，请在题目卡片中作答；点击「下一题」继续。
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
