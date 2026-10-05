/**
 * 思考轨迹（thinking trace）—— 把 Agent 的中间步骤透出来给用户看。
 *
 * 为什么是「管道步骤」而不是「模型思维链」：
 * 当前网关跑的是非推理模型（LLM_MODEL=deepseek/deepseek-chat），上游根本不会
 * 返回 reasoning_content；就算换了推理模型，`llm.ts` 的流式解析也只认 delta.content。
 * 把等待体验押在「上游愿意吐 CoT」上是不可靠的 —— 模型一换、网关一改就白屏。
 *
 * 而这个管道本身是有真实信息量的：
 *   · 查询扩展把「请求是怎么发出去的」映射成了 dispatchRequest / adapter
 *   · BM25 命中了哪些文件块、展开了几条
 *   · 出题时锚定校验没过、正在换一批资料重出
 *   · 判分返回了几分
 * 这些原本全被吞在服务端，用户只看见「Agent 正在思考…」转圈十几秒。
 * 把它们讲出来，既填补了等待，也是可解释性 —— 用户能看出回答是不是有据可查。
 */

/** 一条思考轨迹。detail 是一句话（不是流式正文），因此整体一次性作为事件下发 */
export interface TraceEvent {
  /** 展示分组：检索 / 出题 / 判分 / 提示 / 生成 */
  stage: string;
  /** 一句话说明当前在做什么，应该是「已发生的事实」，不是「即将开始」 */
  detail: string;
}

/**
 * 轨迹接收器。
 *
 * 刻意设计成**可选的、不可抛错的**：轨迹只是体验增强，
 * 任何 write 失败都不能影响主流程（存快照、出题、判分）。
 */
export type TraceSink = ((event: TraceEvent) => void) | undefined;

/** 收口一次上报：没有 sink 就静默跳过 */
export function emitTrace(
  sink: TraceSink,
  stage: string,
  detail: string,
): void {
  if (!sink) return;
  sink({ stage, detail });
}

/**
 * 把检索器的打分压成人话。
 *
 * 裸分数对用户没有意义（BM25 的分值随语料规模浮动，
 * 「28.4 分」和「7.1 分」谁强用户根本判断不了）。
 * 相对强弱他一看就懂，所以只给一档形容词。
 */
export function scoreLabel(score: number): string {
  if (score >= 24) return '高度相关';
  if (score >= 12) return '较相关';
  if (score >= 5) return '弱相关';
  return '边缘命中';
}

/** 标签太长会把面板撑爆；中段省略，保证头尾都看得见 */
export function shortenLabel(label: string, max = 52): string {
  const text = label.trim();
  if (text.length <= max) return text;
  const head = text.slice(0, Math.ceil(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.35));
  return `${head}…${tail}`;
}
