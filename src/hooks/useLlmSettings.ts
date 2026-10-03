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

/** 服务端凭据状态，来自 GET /api/agent/config */
export interface ServerLlmInfo {
  llmConfigured: boolean;
  model: string;
  byok: boolean;
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
        if (alive && data) setInfo(data);
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
