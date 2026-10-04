/**
 * BYOK —— 用户自带 API Key。
 *
 * 部署在公网时，服务端往往没有（也不该有）一个共享的模型 Key。
 * 这时让每个用户用自己的 Key 是最合理的形态：凭据只在他自己的浏览器里，
 * 随请求头传到服务端，用完即弃。
 *
 * 三个请求头（全部可选，但给了 baseUrl / model 就必须给 apiKey）：
 *   x-llm-api-key   sk-...
 *   x-llm-base-url  https://openrouter.ai/api/v1
 *   x-llm-model     deepseek/deepseek-chat
 *
 * 安全性说明：
 *  1. 凭据**只在这一个请求的生命周期里存在** —— 不写库、不落盘、不打日志。
 *  2. baseUrl 是「服务端代替用户去请求」的地址，天然是 SSRF 面。
 *     因此这里挡掉回环 / 内网 / link-local 地址，避免把本站变成内网探测器。
 *     本地开发要连 Ollama 之类的内网网关时，用 ALLOW_PRIVATE_LLM_BASE_URL=1 放行。
 */

import type { LlmOverride } from './config';
import { ApiError } from './http';
import { isPrivateHostname } from './net';

export const HEADER_API_KEY = 'x-llm-api-key';
export const HEADER_BASE_URL = 'x-llm-base-url';
export const HEADER_MODEL = 'x-llm-model';

/** 长度上限：凭据再长也长不过这个量级，超了多半是有人在塞垃圾 */
const MAX_KEY_LEN = 512;
const MAX_URL_LEN = 300;
const MAX_MODEL_LEN = 160;

function header(req: Request, name: string, max: number): string {
  const raw = req.headers.get(name);
  if (!raw) return '';
  return raw.trim().slice(0, max);
}

/** 校验并归一化自定义网关地址；不合法直接 400，别让脏地址流到 fetch */
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ApiError(400, '自定义网关地址不是合法的 URL（示例：https://openrouter.ai/api/v1）');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, '自定义网关地址必须以 http:// 或 https:// 开头');
  }

  const allowPrivate = process.env.ALLOW_PRIVATE_LLM_BASE_URL === '1';
  if (!allowPrivate && isPrivateHostname(url.hostname)) {
    throw new ApiError(
      400,
      '出于安全考虑，自定义网关地址不能指向本机或内网地址。如果你在本地跑网关，请在服务端设置 ALLOW_PRIVATE_LLM_BASE_URL=1。',
    );
  }

  return input.replace(/\/+$/, '');
}

/**
 * 从请求头里解析出这次请求要用的凭据覆盖。
 * 没有任何 BYOK 头时返回 undefined —— 调用方照旧走服务端 .env 的凭据。
 */
export function readLlmOverride(req: Request): LlmOverride | undefined {
  const apiKey = header(req, HEADER_API_KEY, MAX_KEY_LEN);
  const rawBaseUrl = header(req, HEADER_BASE_URL, MAX_URL_LEN);
  const model = header(req, HEADER_MODEL, MAX_MODEL_LEN);

  if (!apiKey) {
    // 只给了网关/模型却没给 Key：明确报错。静默忽略会让用户以为自己的配置生效了
    if (rawBaseUrl || model) {
      throw new ApiError(400, '请求带了自定义网关配置，但缺少 API Key');
    }
    return undefined;
  }

  return {
    apiKey,
    baseUrl: rawBaseUrl ? normalizeBaseUrl(rawBaseUrl) : undefined,
    model: model || undefined,
  };
}
