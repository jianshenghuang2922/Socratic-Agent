'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getAgentClient } from '@/lib/agent';
import { useAgentMode } from '@/hooks/useLlmSettings';
import type { SourceView } from '@/lib/types';

/**
 * 引用来源查看器。
 *
 * 为什么要有它：回答和出题都会标注「依据了哪几处资料」，但那只是一串路径标签。
 * 用户看到 `lib/core/Axios.js › interceptor` 时既无法判断这段内容是否真的支撑了
 * 上面的结论，也无法确认模型是不是在编 —— 溯源的展示如果不可点开，
 * 它就只是一句装饰。
 *
 * 做成 provider 而不是让每个 SourceList 各自弹窗：引用卡片散落在回答气泡、
 * 选择题卡、简答题卡里，各渲染一份弹层会重复 N 份 DOM，也让「同一时刻只可能
 * 有一个查看器」这条约束无处安放。这里由 provider 统一持有状态，
 * 卡片只负责喊一声「打开这个标签」。
 */

interface ViewerApi {
  openSource: (label: string) => void;
}

const ViewerContext = createContext<ViewerApi>({ openSource: () => {} });

/** 在引用卡片里调用，拿到「打开查看器」的入口 */
export function useSourceViewer(): ViewerApi {
  return useContext(ViewerContext);
}

export function SourceViewerProvider({ children }: { children: ReactNode }) {
  const agentMode = useAgentMode();
  const agent = useMemo(() => getAgentClient(), [agentMode]);

  /*
   * 用 nonce 而不是只存 label：连点同一个标签时 label 没变，
   * 只靠它做依赖的话 effect 不会重跑，用户会觉得「点了没反应」。
   */
  const [request, setRequest] = useState<{ label: string; nonce: number } | null>(null);
  const [view, setView] = useState<SourceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const openSource = useCallback((label: string) => {
    setView(null);
    setError(null);
    setLoading(true);
    setRequest((prev) => ({ label, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const close = useCallback(() => {
    setRequest(null);
    setView(null);
    setError(null);
    setLoading(false);
  }, []);

  const open = request !== null;

  useEffect(() => {
    if (!request) return;
    let alive = true;
    agent
      .getSource(request.label)
      .then((v) => {
        if (!alive) return;
        setView(v);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [agent, request]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  return (
    <ViewerContext.Provider value={{ openSource }}>
      {children}
      {open && (
        <SourceModal
          loading={loading}
          view={view}
          error={error}
          onClose={close}
          onRetry={() => request && openSource(request.label)}
        />
      )}
    </ViewerContext.Provider>
  );
}

/* ------------------------------------------------------------------ */

function SourceModal({
  loading,
  view,
  error,
  onClose,
  onRetry,
}: {
  loading: boolean;
  view: SourceView | null;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const hitRef = useRef<HTMLElement>(null);

  // 长文件里被引用的那段可能在几千行之外，不滚过去等于没标
  useEffect(() => {
    if (!view?.focus) return;
    hitRef.current?.scrollIntoView({ block: 'center' });
  }, [view]);

  const isCode = view ? view.category === 'code' || view.category === 'config' : false;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="引用来源">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-card modal-card--viewer">
        <div className="modal-head">
          <div className="viewer-head-text">
            <h2 className="modal-title viewer-title">
              {view ? view.title : '引用来源'}
            </h2>
            <p className="modal-sub">
              {view ? (
                <>
                  {view.kind === 'repo' ? '代码仓库' : '网页'}
                  {view.anchor && <span className="viewer-anchor"> › {view.anchor}</span>}
                  {view.chunks > 1 && <span className="viewer-note">· 由 {view.chunks} 个索引片段重组</span>}
                  {view.truncated && <span className="viewer-note">· 内容过长，已截断</span>}
                </>
              ) : (
                '正在读取…'
              )}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="viewer-body">
          {loading && <div className="viewer-state">正在从本次会话的索引里取回该来源…</div>}

          {!loading && error && (
            <div className="viewer-state viewer-state--error">
              <p>{error}</p>
              <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
                重试
              </button>
            </div>
          )}

          {!loading && !error && view && (
            <>
              <p className="viewer-caveat">
                {view.kind === 'web'
                  ? '以下是该网页中被引用到的章节内容。'
                  : view.chunks > 1
                    ? `以下内容由本次检索索引中的 ${view.chunks} 个片段重组而成，可能与源文件存在细微差异；权威版本请用下方链接打开。`
                    : '以下内容取自本次检索索引中的对应片段，可能与源文件存在细微差异；权威版本请用下方链接打开。'}
              </p>
              {isCode ? (
                <pre className="viewer-code">{withFocus(view.text, view.focus, hitRef)}</pre>
              ) : (
                <div className="viewer-doc">{withFocus(view.text, view.focus, hitRef)}</div>
              )}
            </>
          )}
        </div>

        <div className="viewer-foot">
          <span className="viewer-label" title={view?.label}>
            {view?.label}
          </span>
          {view?.externalUrl && (
            <a
              className="btn btn--ghost btn--sm"
              href={view.externalUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {view.kind === 'repo' ? '在托管站打开 ↗' : '打开原网页 ↗'}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** 把被引用的那一段包起来 —— 用户点开是想看上下文，得知道看的是哪一段 */
function withFocus(
  text: string,
  focus: SourceView['focus'],
  hitRef: React.RefObject<HTMLElement | null>,
) {
  if (!focus) return text;
  return (
    <>
      {text.slice(0, focus.start)}
      <mark className="viewer-hit" ref={hitRef}>
        {text.slice(focus.start, focus.end)}
      </mark>
      {text.slice(focus.end)}
    </>
  );
}
