'use client';

import { useEffect, useState } from 'react';
import { LLM_PRESETS, maskKey, type LlmSettings } from '@/lib/llmSettings';
import type { ServerLlmInfo } from '@/hooks/useLlmSettings';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 当前已保存的设置（未配置为 null） */
  settings: LlmSettings | null;
  /** 服务端凭据状态；null 表示还没探测出来 */
  serverInfo: ServerLlmInfo | null;
  onSave: (next: LlmSettings) => void;
  onClear: () => void;
}

/**
 * 「模型设置」面板 —— 用户自带 API Key 的入口。
 *
 * 为什么需要它：这个应用部署在公网上时，服务端通常**没有**共享的模型 Key
 * （一个公开部署挂一个付费 Key，几分钟就会被刷爆）。
 * 让用户填自己的 Key，是唯一既能让应用真正跑起来、又不用替别人付账的形态。
 *
 * 凭据只存本机浏览器，随请求头发到服务端，服务端只在单次请求里用它调模型。
 */
export function ModelSettings({ open, onClose, settings, serverInfo, onSave, onClear }: Props) {
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(settings?.apiKey ?? '');
  const [model, setModel] = useState(settings?.model ?? '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  // 每次打开都用最新的已存设置回填，避免上次的输入残留
  useEffect(() => {
    if (!open) return;
    setBaseUrl(settings?.baseUrl ?? '');
    setApiKey(settings?.apiKey ?? '');
    setModel(settings?.model ?? '');
    setError('');
  }, [open, settings]);

  /*
   * 「已保存」的复位必须只跟 open 走。
   * 保存成功后 settings 会立刻变成新对象 —— 如果把它也放进上面那个 effect 的依赖里，
   * 复位会在同一轮提交后立刻执行，刚点亮的「已保存 ✓」一帧就被抹掉，
   * 用户根本看不到保存成功的反馈。
   */
  useEffect(() => {
    if (!open) return;
    setSaved(false);
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = () => {
    const key = apiKey.trim();
    if (!key) {
      setError('请填写 API Key');
      return;
    }
    const url = baseUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) {
      setError('网关地址必须以 http:// 或 https:// 开头');
      return;
    }
    setError('');
    onSave({ apiKey: key, baseUrl: url, model: model.trim() });
    setSaved(true);
    // 留一点时间让用户看到「已保存」，再自动收起
    setTimeout(onClose, 420);
  };

  const applyPreset = (id: string) => {
    const preset = LLM_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
    setError('');
  };

  const activePreset = LLM_PRESETS.find(
    (p) => p.baseUrl && p.baseUrl === baseUrl.trim() && p.model === model.trim(),
  );

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="模型设置">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-card">
        <div className="modal-head">
          <div>
            <h2 className="modal-title">模型设置</h2>
            <p className="modal-sub">填入你自己的 API Key，即可使用真实 Agent</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="modal-body">
          {serverInfo && !serverInfo.llmConfigured && (
            <div className="modal-note modal-note--warn">
              本部署<strong>未配置服务端模型凭据</strong>，必须填入你自己的 API Key 才能提问与出题。
            </div>
          )}
          {serverInfo?.llmConfigured && (
            <div className="modal-note">
              本部署已配置服务端模型（{serverInfo.model}）。不填这里也能用；
              填了则<strong>优先使用你自己的 Key</strong>。
            </div>
          )}

          <div className="field">
            <label className="field-label">服务商预设</label>
            <div className="preset-row">
              {LLM_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`chip${activePreset?.id === p.id ? ' chip--on' : ''}`}
                  onClick={() => applyPreset(p.id)}
                  title={p.hint}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="llm-base-url">
              网关地址 <span className="field-hint">OpenAI 兼容</span>
            </label>
            <input
              id="llm-base-url"
              className="field-input"
              type="text"
              spellCheck={false}
              placeholder="https://openrouter.ai/api/v1"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setSaved(false);
              }}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="llm-api-key">
              API Key
            </label>
            <input
              id="llm-api-key"
              className="field-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setError('');
                setSaved(false);
              }}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="llm-model">
              模型名 <span className="field-hint">可留空，用网关默认</span>
            </label>
            <input
              id="llm-model"
              className="field-input"
              type="text"
              spellCheck={false}
              placeholder="deepseek/deepseek-chat"
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setSaved(false);
              }}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>

          {error && <div className="field-error">{error}</div>}

          <p className="modal-fine">
            凭据只保存在<strong>本机浏览器</strong>（localStorage），随每次请求发送到本服务，
            仅用于当次调用模型，不会写入服务端数据库或日志。清除浏览器数据即可删除。
          </p>
        </div>

        <div className="modal-foot">
          {settings ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                onClear();
                setApiKey('');
                setSaved(false);
                onClose();
              }}
            >
              清除已存 Key
            </button>
          ) : (
            <span className="modal-current">当前：未配置</span>
          )}

          <div className="modal-foot-right">
            {settings && (
              <span className="modal-current">
                已存：{maskKey(settings.apiKey)}
                {settings.model ? ` · ${settings.model}` : ''}
              </span>
            )}
            <button type="button" className="btn btn--primary" onClick={submit} disabled={saved}>
              {saved ? '已保存 ✓' : '保存并使用'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
