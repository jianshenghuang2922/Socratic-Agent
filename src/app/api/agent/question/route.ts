import { NextResponse } from 'next/server';
import { readLlmOverride } from '@/server/byok';
import { ApiError, readJson, toErrorResponse } from '@/server/http';
import { chat, extractJson } from '@/server/llm';
import { choiceQuestionMessages, shortQuestionMessages, summarizeHistory } from '@/server/prompts';
import { contextForQuestion, type QuestionContext } from '@/server/rag';
import { tokenize } from '@/server/retrieve';
import { newQuestionId, requireContext, saveAnswerKey } from '@/server/store';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** 最多重出几次 */
const MAX_ATTEMPTS = 3;
/** 题干词元重合率超过这个值就认定是重复题 */
const DUP_THRESHOLD = 0.6;

interface ChoiceDraft {
  prompt?: unknown;
  options?: unknown;
  correctIndex?: unknown;
  explanation?: unknown;
}

interface ShortDraft {
  prompt?: unknown;
  reference?: unknown;
}

function asText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** 两道题的相似度：词元交集 / 较短一方，取值 0~1 */
function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits += 1;
  return hits / Math.min(ta.size, tb.size);
}

/**
 * 检查题干是否锚定到了资料里的具体名称。
 *
 * 这是对「八股式提问」的硬约束：光在提示词里说「要引用文件名」模型经常不听，
 * 所以在服务端也验一遍 —— 题干里至少得有一个词，是本次资料里真实出现过的标识符
 * （文件名、函数名、配置项等）。
 */
function hasConcreteAnchor(prompt: string, bundle: QuestionContext): boolean {
  const haystack = `${bundle.sources.join('\n')}\n${bundle.text}`.toLowerCase();
  const candidates = prompt.match(/[A-Za-z][A-Za-z0-9_$.-]{2,}/g) ?? [];

  for (const raw of candidates) {
    const token = raw.toLowerCase().replace(/[.,]+$/, '');
    if (token.length < 3) continue;
    // 形如 `Axios.js` / `lib/core` 的写法本身就说明在指位置
    if (/[./]/.test(token)) return true;
    if (haystack.includes(token)) return true;
  }
  return false;
}

/** 校验模型出的选择题，不合规一律当 502 抛出，由外层决定是否重出 */
function parseChoiceDraft(raw: string) {
  const draft = extractJson<ChoiceDraft>(raw, '选择题');
  const prompt = asText(draft.prompt, 300);
  const options = Array.isArray(draft.options)
    ? draft.options.map((o) => asText(o, 200)).filter(Boolean)
    : [];
  const correctIndex = Number(draft.correctIndex);

  if (!prompt) throw new ApiError(502, '模型出的选择题缺少题干');
  if (options.length < 2) throw new ApiError(502, '模型出的选择题选项不足');
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
    throw new ApiError(502, '模型给出的正确答案下标越界');
  }

  return { prompt, options, correctIndex, explanation: asText(draft.explanation, 600) };
}

function parseShortDraft(raw: string) {
  const draft = extractJson<ShortDraft>(raw, '简答题');
  const prompt = asText(draft.prompt, 200);
  const reference = asText(draft.reference, 800);

  if (!prompt) throw new ApiError(502, '模型出的简答题缺少题干');
  if (!reference) throw new ApiError(502, '模型没有给出参考答案');

  return { prompt, reference };
}

/**
 * POST /api/agent/question
 * body: { contextId, mode: 'choice' | 'short', history }
 *
 * 回答模式：RAG 召回后出题。
 *
 * 召回策略与提问模式不同 —— 出题没有查询词，所以走
 * 「薄弱点回捞（针对这个人）+ 全项目均匀采样（保证覆盖面）」。
 *
 * 正确答案只写进服务端会话表，响应里只回题干与选项。
 *
 * 出题的四个坑，逐个堵：
 *  1. 模型返回不合规 JSON / 下标越界 —— 重出。
 *  2. 模型无视「不要重复」的提示 —— 用词元重合率做确定性判重，重出。
 *  3. 模型出成八股定义题 —— 服务端校验题干是否锚定了资料里的具体名称，没有就重出。
 *  4. 每次都盯着资料开头 —— 均匀采样 + 轮次错开起点。
 */
export async function POST(req: Request) {
  try {
    const override = readLlmOverride(req);
    const body = await readJson<{ contextId?: string; mode?: string; history?: unknown }>(req);
    const ctx = requireContext(body.contextId);

    const mode = body.mode === 'short' ? 'short' : 'choice';
    const { askedQuestions } = summarizeHistory(body.history);
    const questionId = newQuestionId();

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        // 重试时换一批采样块，绕开刚出过题的那段资料
        const bundle = await contextForQuestion(ctx, askedQuestions.length + attempt * 3, override);

        const opts = {
          askedQuestions,
          focus: bundle.focus.map((f) => f.prompt),
          sources: bundle.sources,
          extraHint:
            attempt === 0
              ? undefined
              : '刚才那一版不合格（重复、或没有引用资料里的具体文件/函数名）。请换一个知识点或换一个角度，并确保题干里出现资料中的具体名称。',
        };

        const messages =
          mode === 'choice'
            ? choiceQuestionMessages(ctx, bundle.text, opts)
            : shortQuestionMessages(ctx, bundle.text, opts);

        const raw = await chat(messages, {
          temperature: attempt === 0 ? 0.9 : 1.0,
          maxTokens: 2500,
          override,
        });

        if (mode === 'choice') {
          const q = parseChoiceDraft(raw);
          if (askedQuestions.some((prev) => similarity(prev, q.prompt) >= DUP_THRESHOLD)) {
            throw new ApiError(502, '模型重复出题');
          }
          // 最后一次尝试不再卡锚定，避免因为过度严格而整个请求失败
          const lastChance = attempt === MAX_ATTEMPTS - 1;
          if (!lastChance && !hasConcreteAnchor(q.prompt, bundle)) {
            throw new ApiError(502, '题目没有锚定到资料中的具体位置');
          }

          saveAnswerKey(ctx.id, questionId, {
            prompt: q.prompt,
            options: q.options,
            correctIndex: q.correctIndex,
            explanation: q.explanation,
            sourceLabels: bundle.sources,
          });
          return NextResponse.json({
            id: questionId,
            type: 'choice',
            prompt: q.prompt,
            options: q.options,
            sources: bundle.sources,
          });
        }

        const q = parseShortDraft(raw);
        if (askedQuestions.some((prev) => similarity(prev, q.prompt) >= DUP_THRESHOLD)) {
          throw new ApiError(502, '模型重复出题');
        }
        const lastChance = attempt === MAX_ATTEMPTS - 1;
        if (!lastChance && !hasConcreteAnchor(q.prompt, bundle)) {
          throw new ApiError(502, '题目没有锚定到资料中的具体位置');
        }

        saveAnswerKey(ctx.id, questionId, {
          prompt: q.prompt,
          reference: q.reference,
          sourceLabels: bundle.sources,
        });
        return NextResponse.json({
          id: questionId,
          type: 'short',
          prompt: q.prompt,
          sources: bundle.sources,
        });
      } catch (err) {
        lastError = err;
        // 只有「模型输出不合规 / 重复 / 不够具体」值得重出；会话过期、网关故障等直接上抛
        if (!(err instanceof ApiError) || err.status !== 502) throw err;
      }
    }

    throw lastError;
  } catch (err) {
    return toErrorResponse(err);
  }
}
