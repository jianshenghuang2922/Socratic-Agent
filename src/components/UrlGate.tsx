'use client';

import { useState } from 'react';
import type { AgentMode } from '@/lib/agent';
import type { TrialQuota } from '@/lib/trial';

interface Props {
  loading: boolean;
  error?: string;
  agentMode: AgentMode;
  /** 服务端没配 Key、用户也没填 —— 此时必须先引导他填，否则一提问就报错 */
  needsKey: boolean;
  /** 免费试用额度；null 表示还没探测到 */
  trial: TrialQuota | null;
  onOpenSettings: () => void;
  onSubmit: (url: string) => void;
}

/**
 * 示例必须「小而快」。
 * 线上是 512MB 的免费实例，浅克隆 + 建索引大 monorepo（比如 vercel/next.js）
 * 会直接超时或 OOM —— 用户第一次点下去就撞墙，是最贵的流失点。
 * 加示例之前先实测一遍解析耗时，别凭仓库名气挑。
 */
const SAMPLES = [
  { label: 'Socratic-Agent 自己', url: 'https://github.com/jianshenghuang2922/Socratic-Agent' },
  { label: 'github.com/ai/nanoid', url: 'https://github.com/ai/nanoid' },
  { label: '维基百科 · 苏格拉底', url: 'https://zh.wikipedia.org/wiki/苏格拉底' },
];

function normalize(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProto);
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** URL 输入区：首次进入页面时展示，提交后建立问答上下文 */
export function UrlGate({
  loading,
  error,
  agentMode,
  needsKey,
  trial,
  onOpenSettings,
  onSubmit,
}: Props) {
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState('');

  const submit = () => {
    const url = normalize(value);
    if (!url) {
      setLocalError('请输入有效的 URL，例如 https://example.com/article');
      return;
    }
    setLocalError('');
    onSubmit(url);
  };

  /*
   * 入口的三种状态，决定「进门先说哪句话」：
   *   1. 有免费额度 ⇒ 直接放进来用（**绝不能在这个位置要 Key**，用户还没看到任何价值）；
   *   2. 额度用尽   ⇒ 说明白并引导自带 Key；
   *   3. 服务端没凭据 ⇒ 只能引导自带 Key。
   * 第 1 种是绝大多数访客会遇到的路径，也是转化率的关键 ——
   * 之前这里只有 2 和 3，等于让每个新访客先交一份 Key 才能看到东西。
   */
  const trialExhausted = trial?.available === true && trial.remaining <= 0;
  const blocked = needsKey || trialExhausted;

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-badge">V1.1</div>
        <h1 className="gate-title gate-title--plain">我不是做题区！</h1>
        <p className="gate-sub">
          粘贴一个<strong>网页</strong>或<strong>代码仓库</strong>地址。它读完内容后出题考你 ——
          题干锚定原文里真实存在的段落与函数，答错的题会成为后续出题的靶子。
        </p>

        {blocked ? (
          <div className="gate-key">
            <div className="gate-key__text">
              {needsKey ? (
                <>
                  本部署没有配置服务端模型凭据。<strong>填入你自己的 API Key</strong>
                  即可正常提问与出题 —— Key 只存在你的浏览器里。
                </>
              ) : (
                <>
                  免费额度已用完（{trial?.limit ?? 0} 次 / 24 小时）。
                  <strong>填入你自己的 API Key</strong> 即可继续，不受此限制 ——
                  Key 只存在你的浏览器里。
                </>
              )}
            </div>
            <button type="button" className="btn btn--primary btn--sm" onClick={onOpenSettings}>
              去填 API Key
            </button>
          </div>
        ) : (
          <>
            <div className={`gate-mode gate-mode--${agentMode === 'mock' ? 'mock' : 'live'}`}>
              <span className="gate-mode__dot" />
              {agentMode === 'mock'
                ? '当前为模拟模式（前端联调数据），回答不来自真实模型'
                : '当前为真实 Agent，将调用大模型作答'}
            </div>

            {trial?.available && (
              <div className="gate-quota">
                免费额度 剩余 <strong>{trial.remaining}</strong> / {trial.limit} 次（24 小时内）
                <span className="gate-quota__hint">用完后可在右上角填自己的 Key 继续</span>
              </div>
            )}
          </>
        )}

        <div className="gate-form">
          <input
            type="text"
            className="gate-input"
            placeholder="https://example.com/article 或 https://github.com/user/repo"
            value={value}
            disabled={loading}
            autoFocus
            onChange={(e) => {
              setValue(e.target.value);
              setLocalError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <button type="button" className="btn btn--primary btn--lg" disabled={loading} onClick={submit}>
            {loading ? '解析中…' : '开始问答'}
          </button>
        </div>

        {(localError || error) && <div className="gate-error">{localError || error}</div>}

        <div className="gate-samples">
          <span className="gate-samples-label">试试：</span>
          {SAMPLES.map((s) => (
            <button
              key={s.url}
              type="button"
              className="chip"
              disabled={loading}
              onClick={() => setValue(s.url)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
