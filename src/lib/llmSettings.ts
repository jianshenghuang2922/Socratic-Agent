/**
 * 「用户自带 API Key」（BYOK）的浏览器侧存储。
 *
 * 设计约束：
 *  1. **只在浏览器里存** —— localStorage，不上报、不落服务端库。
 *     服务端只在单次请求里用它调模型，用完即弃。
 *  2. 快照必须是**稳定引用**，否则 useSyncExternalStore 会无限重渲染。
 *     所以这里做一层缓存，只在保存/清除/跨标签页变更时替换。
 *  3. 允许在模块顶层被调用（SSR 时返回 null），调用方不必到处判 window。
 */

export interface LlmSettings {
  /** 用户的 API Key，必填 */
  apiKey: string;
  /** OpenAI 兼容网关地址；留空则用服务端默认 */
  baseUrl: string;
  /** 模型名；留空则用服务端默认 */
  model: string;
}

export interface LlmPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  /** 界面上的一行补充说明 */
  hint?: string;
}

/**
 * 常用网关预设 —— 只是把地址和模型名填好，用户仍可随意改。
 * 全部是 OpenAI 兼容的 /chat/completions 网关，与本项目的调用方式一致。
 */
export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    hint: '聚合网关，一个 Key 可用多家模型',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '国内直连，价格低',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    hint: '国内直连，有多种开源模型',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '国内需自备网络条件',
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    model: '',
    hint: '任何 OpenAI 兼容网关',
  },
];

const STORAGE_KEY = 'socratic.llm.v1';

/** 缓存快照：保证同一份设置在多次 getSnapshot 之间是同一个对象 */
let snapshot: LlmSettings | null = null;
let loaded = false;
const listeners = new Set<() => void>();

/** 稳定引用的「服务端快照」—— SSR 阶段一律当作未配置 */
const serverSnapshot = () => null;

function normalize(raw: unknown): LlmSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<LlmSettings>;
  const apiKey = typeof v.apiKey === 'string' ? v.apiKey.trim() : '';
  // 没有 Key 就等于没配置 —— 网关和模型单独存在毫无意义
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl.trim() : '',
    model: typeof v.model === 'string' ? v.model.trim() : '',
  };
}

function readFromStorage(): LlmSettings | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalize(JSON.parse(raw));
  } catch {
    // 隐私模式 / 存储被禁用 / 存的是坏 JSON —— 一律当未配置，别让页面崩掉
    return null;
  }
}

function notify() {
  for (const fn of listeners) fn();
}

/** 当前设置；未配置时为 null。同步可用，服务端渲染时恒为 null。 */
export function getLlmSettings(): LlmSettings | null {
  if (typeof window === 'undefined') return null;
  if (!loaded) {
    snapshot = readFromStorage();
    loaded = true;
    bindStorageEvent();
  }
  return snapshot;
}

export function saveLlmSettings(next: LlmSettings): LlmSettings | null {
  const normalized = normalize(next);
  snapshot = normalized;
  loaded = true;
  try {
    if (normalized) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 存不下也不影响本次会话使用：内存里的 snapshot 已经生效
  }
  notify();
  return normalized;
}

export function clearLlmSettings(): void {
  snapshot = null;
  loaded = true;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 同上 */
  }
  notify();
}

export function subscribeLlmSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 供 useSyncExternalStore 使用的稳定引用读取函数 */
export function getLlmSettingsSnapshot(): LlmSettings | null {
  return getLlmSettings();
}

export function getServerLlmSettingsSnapshot(): LlmSettings | null {
  return serverSnapshot();
}

/** 别的标签页改了设置，本页跟着变 */
let storageBound = false;
function bindStorageEvent() {
  if (storageBound || typeof window === 'undefined') return;
  storageBound = true;
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    snapshot = readFromStorage();
    notify();
  });
}

/**
 * 拼出随请求发送的凭据请求头。
 * 每次请求现算 —— 用户改完设置立刻生效，不必重建客户端实例。
 */
export function getLlmHeaders(): Record<string, string> {
  const s = getLlmSettings();
  if (!s) return {};
  const headers: Record<string, string> = { 'x-llm-api-key': s.apiKey };
  if (s.baseUrl) headers['x-llm-base-url'] = s.baseUrl;
  if (s.model) headers['x-llm-model'] = s.model;
  return headers;
}

/** 展示用的掩码，别把完整 Key 印在界面上 */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 10) return `${k.slice(0, 2)}…${k.slice(-2)}`;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
