'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { resolveAgentMode, type AgentMode } from '@/lib/agent';
import {
  clearLlmSettings,
  getLlmSettingsSnapshot,
  getServerLlmSettingsSnapshot,
  saveLlmSettings,
  subscribeLlmSettings,
  type LlmSettings,
} from '@/lib/llmSettings';
import {
  getServerTrialSnapshot,
  getTrialSnapshot,
  publishTrial,
  subscribeTrial,
  type TrialQuota,
} from '@/lib/trial';

/** 服务端凭据状态，来自 GET /api/agent/config */
export interface ServerLlmInfo {
  llmConfigured: boolean;
  model: string;
  byok: boolean;
  /** 免费试用额度；服务端没配凭据时 available 为 false */
  trial?: TrialQuota;
}

/** 读写用户自带的模型凭据 */
export function useLlmSettings() {
  const settings = useSyncExternalStore(
    subscribeLlmSettings,
    getLlmSettingsSnapshot,
    getServerLlmSettingsSnapshot,
  );

  const save = useCallback((next: LlmSettings) => saveLlmSettings(next), []);
  const clear = useCallback(() => clearLlmSettings(), []);

  return { settings, save, clear };
}

/**
 * 当前生效的 Agent 实现。
 * 订阅设置变化 —— 用户保存/清除 Key 会让模式在 mock 与 http 之间切换，
 * 页面必须跟着重渲染并换掉客户端实例。
 */
export function useAgentMode(): AgentMode {
  useSyncExternalStore(
    subscribeLlmSettings,
    getLlmSettingsSnapshot,
    getServerLlmSettingsSnapshot,
  );
  return resolveAgentMode();
}

/** 探一次服务端有没有配模型凭据；失败就当作「未知」（返回 null） */
export function useServerLlmInfo(): ServerLlmInfo | null {
  const [info, setInfo] = useState<ServerLlmInfo | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/agent/config')
      .then((res) => (res.ok ? (res.json() as Promise<ServerLlmInfo>) : null))
      .then((data) => {
        if (!alive || !data) return;
        setInfo(data);
        // 顺手把额度灌进外部 store：此后由 SSE 的 quota 事件保持新鲜
        publishTrial(data.trial);
      })
      .catch(() => {
        /* 探测失败不影响主流程，界面按「未知」处理 */
      });
    return () => {
      alive = false;
    };
  }, []);

  return info;
}

/**
 * 当前剩余免费额度。
 *
 * 初值来自 /api/agent/config，之后每次动作结束由 SSE 的 quota 事件更新 ——
 * 所以不需要在动作完成后额外拉一次接口（那一次往返恰好发生在用户最不耐烦时）。
 * 用户填了自带 Key 时不该展示这个数字，调用方自己判断。
 */
export function useTrialQuota(): TrialQuota | null {
  return useSyncExternalStore(subscribeTrial, getTrialSnapshot, getServerTrialSnapshot);
}
