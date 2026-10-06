'use client';

import { useCallback, useEffect, useState } from 'react';
import { copyText } from '@/lib/clipboard';
import type { SharedQuizLink } from '@/lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * 生成分享链接。对同一会话**幂等** —— 服务端会复用同一个 id，
   * 所以这里可以放心地每次打开都调一次，不必在前端缓存链接。
   */
  onGenerate: () => Promise<SharedQuizLink>;
}

/**
 * 「分享测验」弹层。
 *
 * 这是整个应用的**扩散出口**：在此之前，用户做完题的唯一去处是关掉页面。
 * 弹层里只说三件用户真正关心的事 —— 链接是什么、别人做要不要花钱、链接活多久。
 *
 * 尤其是第二条：如果不说清楚「别人做这套题不消耗任何额度」，
 * 用户会本能地担心「我发出去是不是在烧自己的配额」，于是干脆不发。
 */
export function ShareQuiz({ open, onClose, onGenerate }: Props) {
  const [link, setLink] = useState<SharedQuizLink | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLink(null);
    setError('');
    setCopied(false);
    setLoading(true);
    let alive = true;
    onGenerate()
      .then((result) => {
        if (alive) setLink(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    // 关掉再打开要重新生成：用户可能刚又出了几道题，链接内容应该跟上
    return () => {
      alive = false;
    };
  }, [open, onGenerate]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const shareUrl = link ? `${window.location.origin}/quiz/${link.quizId}` : '';

  const copy = useCallback(async () => {
    if (!shareUrl) return;
    const ok = await copyText(shareUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      return;
    }
    // 剪贴板两层都失败：退回让用户手动复制，至少别让他以为按钮坏了
    window.prompt('复制这条链接发给别人：', shareUrl);
  }, [shareUrl]);

  if (!open) return null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="分享测验">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-card">
        <div className="modal-head">
          <div>
            <h2 className="modal-title">分享这套测验</h2>
            <p className="modal-sub">把这次会话里已出的选择题打包成一条链接</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="modal-body">
          {loading && (
            <div className="share-loading">
              <div className="spinner" />
              <span>正在打包题目…</span>
            </div>
          )}

          {error && <div className="modal-note modal-note--warn">{error}</div>}

          {link && (
            <>
              <div className="modal-note">
                已打包 <strong>{link.count}</strong> 道题
                {link.players > 0 && <>（已有 {link.players} 人做过）</>}。
                别人打开就能做，<strong>不需要任何模型额度</strong> ——
                判分是服务端直接比对答案，不调模型，做一百遍也不消耗一分钱。
              </div>

              <div className="field">
                <label className="field-label" htmlFor="quiz-link">
                  测验链接
                </label>
                <div className="share-row">
                  <input
                    id="quiz-link"
                    className="field-input"
                    type="text"
                    readOnly
                    value={shareUrl}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button type="button" className="btn btn--primary" onClick={copy}>
                    {copied ? '已复制 ✓' : '复制'}
                  </button>
                </div>
              </div>

              <p className="modal-fine">
                链接有效期 <strong>7 天</strong>。只分享选择题 ——
                简答题需要模型批改，把它开放给陌生人等于把服务端账号的配额直接送出去。
                正确答案留在服务端，页面上翻不出来。
              </p>
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="modal-current">
            {link ? `来源：${link.title}` : ''}
          </span>
          <div className="modal-foot-right">
            {shareUrl && (
              <a
                className="btn btn--ghost btn--sm"
                href={shareUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                打开预览
              </a>
            )}
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
