import { NextResponse } from 'next/server';

/** 带 HTTP 状态码的业务异常，路由层统一转成 JSON 响应 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

/** 把任意异常收敛成前端可展示的错误响应 */
export function toErrorResponse(err: unknown) {
  if (err instanceof ApiError) {
    return jsonError(err.status, err.message);
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error('[agent api] 未预期的错误:', err);
  return jsonError(500, `服务端异常：${message}`);
}

/** 读取并校验 JSON 请求体 */
export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, '请求体不是合法的 JSON');
  }
}

export function requireString(value: unknown, field: string, maxLen = 20000): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, `缺少必填字段：${field}`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLen) {
    throw new ApiError(400, `字段 ${field} 超出长度上限（${maxLen}）`);
  }
  return trimmed;
}

/** 把上游网络异常翻译成人话 */
export function describeNetworkError(err: unknown, what: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/abort|timeout/i.test(message)) return `${what}超时，请稍后重试或换一个 URL`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return `${what}失败：无法解析域名`;
  if (/ECONNREFUSED|ECONNRESET/i.test(message)) return `${what}失败：连接被拒绝或中断`;
  return `${what}失败：${message}`;
}

/**
 * 流式场景下的错误归一化。
 *
 * 与 `toErrorResponse` 的区别：那里要决定 HTTP 状态码，这里只要一句人话。
 * SSE 一旦开始吐字，响应头就发出去了，改不了状态码，所以错误统一走 `error` 事件，
 * 前端只需要一个稳定的中文文案。
 */
export function describeUpstream(err: unknown): string {
  // 业务异常（模型全部失败、模型输出不合规等）本身就是给人看的
  if (err instanceof ApiError) return err.message;

  const message = err instanceof Error ? err.message : String(err);
  if (/abort|timeout/i.test(message)) return '上游响应超时，请重试';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return '无法连接模型网关，请检查网络或网关地址';
  if (/ECONNREFUSED|ECONNRESET/i.test(message)) return '与模型网关的连接被中断，请重试';

  console.error('[agent stream] 未预期的错误:', err);
  return `服务端异常：${message}`;
}
