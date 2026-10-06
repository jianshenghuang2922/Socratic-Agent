import { buildContext } from '@/server/context';
import { readLlmOverride } from '@/server/byok';
import { describeUpstream, readJson, requireString } from '@/server/http';
import { claimTrial, toErrorResponseWithTrial, trialQuota, type TrialClaim } from '@/server/trial';
import type { TraceSink } from '@/server/trace';

export const runtime = 'nodejs';
/** 克隆仓库可能较慢，放宽执行上限 */
export const maxDuration = 300;

/**
 * POST /api/agent/context/stream
 * body: { url }
 *
 * 与 `POST /api/agent/context` 做同一件事，但把过程讲出来。
 *
 * 为什么值得单独开一个端点：**URL 解析是整个应用里最长的等待**。
 * 代码仓库要浅克隆（超时上限 180s）+ 扫描 + 逐文件切块建索引，
 * 而原来前端只有一个不动的 spinner —— 用户完全无法判断是卡死了还是在干活。
 * 现在克隆有心跳、扫描和索引各有阶段汇报，等待被切成看得懂的段落。
 *
 * 事件协议（`data:` 行内是 JSON）：
 *   { "type": "trace",  "stage": "克隆", "detail": "…" }   中间过程，一条一句话
 *   { "type": "result", "result": { contextId, url, kind, title, summary, size, chunks } }
 *   { "type": "done" }                                      正常结束
 *   { "type": "error",  "error": "中文提示" }                出错
 *
 * 前端**没有**为它准备一次性退路：SSE 在本应用里是既有前提（提问 / 出题 /
 * 判分 / 提示全走 SSE），如果它不可用，整个应用本来就用不了。
 * 留一条静默退路只会让「流式坏了」再次变成无人察觉的隐性故障。
 */
export async function POST(req: Request) {
  let url: string;
  let claim: TrialClaim | null = null;

  // 参数校验放在建立流之前 —— 这些错误还能用正常状态码返回
  try {
    const body = await readJson<{ url?: string }>(req);
    url = requireString(body.url, 'url', 2048);
    /*
     * 额度也在建流之前占：这样「额度用完」能用正常的 429 状态码返回，
     * 前端拿到的是结构化错误，而不是流里飘出来的一个 error 事件。
     * override 必须一起传 —— 带了自带 Key 的请求不占服务端额度。
     */
    claim = claimTrial(req, readLlmOverride(req));
  } catch (err) {
    return toErrorResponseWithTrial(err, req);
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      /** 是否已经产生了用户可见的结果 —— 决定失败时退不退额度 */
      let visible = false;
      const send = (payload: unknown) => {
        if (closed) return;
        if ((payload as { type?: string })?.type === 'result') visible = true;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // 客户端已断开，后续 enqueue 都会抛；静默忽略即可
          closed = true;
        }
      };

      const trace: TraceSink = (event) => send({ type: 'trace', ...event });

      try {
        const result = await buildContext(url, trace);
        send({ type: 'result', result });
        const quota = trialQuota(req);
        if (quota.available) send({ type: 'quota', trial: quota });
        send({ type: 'done' });
      } catch (err) {
        console.error('[context/stream] 失败:', err);
        /*
         * 没给到任何结果才退额度。克隆失败、仓库太大这类失败是服务端的问题，
         * 不该算在用户头上 —— 不退的话他还没开始用就把次数耗光了。
         */
        if (!visible) claim?.refund();
        // 已经开始发事件了，状态码改不了，只能把错误当事件发；同样归一化成中文
        send({ type: 'error', error: describeUpstream(err) });
        const quota = trialQuota(req);
        if (quota.available) send({ type: 'quota', trial: quota });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* 已经关了 */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // 必须禁掉缓冲，否则中间层会把整个流攒完再吐 —— 那就完全失去了「实时」的意义
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
