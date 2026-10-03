import { readLlmOverride } from '@/server/byok';
import { describeUpstream, readJson, requireString, toErrorResponse } from '@/server/http';
import { chatStream } from '@/server/llm';
import { askMessages, summarizeHistory } from '@/server/prompts';
import { contextForAsk, memoryDigest } from '@/server/rag';
import { recordUserQuery, requireContext } from '@/server/store';
import type { LlmOverride } from '@/server/config';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/agent/ask/stream
 * body: { contextId, question, history }
 *
 * 与 `/api/agent/ask` 完全同源（同样的检索、同样的提示词），
 * 只是把答案改成 SSE 逐段下发。完整答案要 20s 左右，等它一次性返回体感很差。
 *
 * 事件协议（`data:` 行内是 JSON）：
 *   { "type": "sources", "sources": [...] }   首帧，先告诉前端依据了哪些资料
 *   { "type": "delta",   "text": "..." }      增量正文
 *   { "type": "done" }                        正常结束
 *   { "type": "error",   "error": "中文提示" } 出错（HTTP 仍是 200，错误走事件）
 *
 * 错误为什么走事件而不是状态码：一旦开始吐字，响应头已经发出去了，
 * 这时改不了状态码。统一用 `error` 事件让前端有唯一处理路径。
 */
export async function POST(req: Request) {
  let ctx: ReturnType<typeof requireContext>;
  let question: string;
  let history: unknown;
  let override: LlmOverride | undefined;

  // 参数校验放在建立流之前 —— 这些错误还能用正常状态码返回
  try {
    override = readLlmOverride(req);
    const body = await readJson<{ contextId?: string; question?: string; history?: unknown }>(req);
    question = requireString(body.question, 'question', 4000);
    ctx = requireContext(body.contextId);
    history = body.history;
  } catch (err) {
    return toErrorResponse(err);
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // 客户端已断开，后续 enqueue 都会抛；静默忽略即可
          closed = true;
        }
      };

      try {
        const { recentTurns, recentUserTurns } = summarizeHistory(history);

        // 检索本身也是 LLM 调用（查询扩展），先发一个「检索中」信号，
        // 让前端知道这段时间不是在干等
        send({ type: 'status', text: '正在检索资料…' });

        const bundle = await contextForAsk(ctx, question, recentUserTurns, override);

        send({ type: 'sources', sources: bundle.sources });

        await chatStream(
          askMessages(ctx, question, bundle.text, recentTurns, memoryDigest(ctx)),
          (delta) => send({ type: 'delta', text: delta }),
          { temperature: 0.3, maxTokens: 2500, override },
        );

        // 用户的问题本身也是「用户回复」，记下来并进索引
        recordUserQuery(ctx.id, question);

        send({ type: 'done' });
      } catch (err) {
        console.error('[ask/stream] 失败:', err);
        // 走流式时就改不了状态码了，只能把错误当事件发；同样要归一化成中文
        send({ type: 'error', error: describeUpstream(err) });
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
      // 必须禁掉缓冲，否则中间层会把整个流攒完再吐
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
