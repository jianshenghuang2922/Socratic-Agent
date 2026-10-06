'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAgentClient } from '@/lib/agent';
import { useAgentMode } from '@/hooks/useLlmSettings';
import type {
  ChatMessage,
  ChatMode,
  ChoiceQuestion,
  Question,
  QuestionType,
  SessionPhase,
  ShortQuestion,
  StatusState,
  TraceEvent,
  UrlContext,
} from '@/lib/types';

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq += 1)}`;

/** 选择题答对的分值；简答题满分同值（得几分加几分） */
export const POINTS_PER_CORRECT = 5;

/** 判断一条消息是否是「待作答的题目」（被作废的不算） */
function isPendingQuestion(m: ChatMessage): m is Extract<ChatMessage, { kind: 'question' }> {
  return m.kind === 'question' && m.question.submitted !== true && m.question.abandoned !== true;
}

export function useQASession() {
  /** 用户自带 Key 时会从 mock 切到真实后端，因此这里要跟着模式走 */
  const agentMode = useAgentMode();
  const agent = useMemo(() => getAgentClient(), [agentMode]);

  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [context, setContext] = useState<UrlContext | null>(null);
  const [mode, setMode] = useState<ChatMode>('ask');
  const [questionType, setQuestionType] = useState<QuestionType>('choice');
  /**
   * 回答模式下，题型是否已由用户亲自选定。
   * 未选定前不出题 —— 否则「切换到回答模式」等于替用户默认选了选择题并立刻开跑，
   * 而出题期间题型按钮被 busy 锁死，用户想改都改不了。
   */
  const [typeChosen, setTypeChosen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<StatusState>({ kind: 'idle', text: '' });
  const [busy, setBusy] = useState(false);
  /**
   * 当前动作的思考轨迹。
   *
   * 生命周期刻意跟 `busy` 绑死：动作一结束就清空。
   * 不把它留在 state 里等「有人来取」是因为那会引入一类很难发现的 bug ——
   * 动作结束了但轨迹还挂着，面板就会显示一段早已结束的过程，
   * 用户会以为 Agent 还在忙。收尾时各动作会先把它写进消息再清空。
   */
  const [liveTrace, setLiveTrace] = useState<TraceEvent[]>([]);

  /** 收集本次动作的轨迹：既给实时面板用，也攒下来供收尾时归档到消息里 */
  const makeTraceCollector = useCallback(() => {
    const collected: TraceEvent[] = [];
    setLiveTrace([]);
    const onTrace = (event: TraceEvent) => {
      collected.push(event);
      setLiveTrace([...collected]);
    };
    return { onTrace, collected, clear: () => setLiveTrace([]) };
  }, []);

  /* ---------------- 计分 ---------------- */

  const [score, setScore] = useState(0);
  const [questionCount, setQuestionCount] = useState(0);
  /** 每次加分自增，用作高亮动画的触发键（用布尔值无法连续触发） */
  const [pulseAt, setPulseAt] = useState(0);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (!pulseAt) return;
    setPulsing(true);
    const timer = setTimeout(() => setPulsing(false), 900);
    return () => clearTimeout(timer);
  }, [pulseAt]);

  /** 加分并触发高亮；简答题按得分传点数，0 分不加也不闪 */
  const award = useCallback((points: number = POINTS_PER_CORRECT) => {
    if (points <= 0) return;
    setScore((prev) => prev + points);
    setPulseAt(Date.now());
  }, []);

  /** 防止 StrictMode 双调用 / 并发重复出题 */
  const generatingRef = useRef(false);

  const push = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const pushNotice = useCallback(
    (content: string) => {
      push({ id: uid('notice'), role: 'agent', kind: 'notice', content, ts: Date.now() });
    },
    [push],
  );

  const fail = useCallback(
    (err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      /*
       * 状态栏文案必须是真实原因，不能退化成一句「出错了」。
       * 建立上下文失败时页面停在 URL 输入页 —— 那里没有消息列表，
       * 唯一能看到错误的地方就是状态栏（UrlGate 直接读 status.text）。
       * 写成「出错了」等于把「404 页面不存在」「该仓库为私有」这类
       * 可直接行动的信息全部丢掉。超长文案由 CSS 省略号处理。
       */
      setStatus({ kind: 'error', text });
      pushNotice(`⚠️ ${text}`);
      setBusy(false);
    },
    [pushNotice],
  );

  /* ---------------- URL 上下文初始化 ---------------- */

  const initSession = useCallback(
    async (rawUrl: string) => {
      const url = rawUrl.trim();
      if (!url) return;
      setPhase('initializing');
      setBusy(true);
      setStatus({ kind: 'loading', text: '正在解析 URL 内容…' });
      /*
       * 解析过程也要能看见：这是全流程里最长的一段等待（仓库要浅克隆，
       * 超时上限 180s），原来这里只有一个不动的 spinner。
       */
      const { onTrace, collected, clear } = makeTraceCollector();
      try {
        const ctx = await agent.initContext(url, onTrace);
        setContext(ctx);
        setPhase('ready');
        setMessages([
          {
            id: uid('agent'),
            role: 'agent',
            kind: 'text',
            ts: Date.now(),
            content: `已建立问答上下文：**${ctx.title}**\n\n${ctx.summary ?? ''}${
              ctx.chunks ? `\n\n已建立检索索引（${ctx.chunks} 个语义块），提问与出题都会先从这里检索相关内容。` : ''
            }\n\n当前为「提问模式」，你可以直接向我提问；切换到「回答模式」则由我来出题 —— 题型（选择题 / 简答题）由你选定后才会开始。`,
            // 归档解析过程：用户能回看「这个上下文是怎么建起来的」（扫描了多少文件、过滤了多少块）
            trace: collected.length ? collected : undefined,
          },
        ]);
        setStatus({ kind: 'success', text: '上下文已就绪' });
      } catch (err) {
        setPhase('idle');
        fail(err);
        return;
      } finally {
        clear();
        setBusy(false);
      }
    },
    [agent, fail, makeTraceCollector],
  );

  const resetSession = useCallback(() => {
    setPhase('idle');
    setContext(null);
    setMessages([]);
    setMode('ask');
    setQuestionType('choice');
    setTypeChosen(false);
    setStatus({ kind: 'idle', text: '' });
    setBusy(false);
    setLiveTrace([]);
    // 换 URL = 开新会话，得分与题数一并归零
    setScore(0);
    setQuestionCount(0);
    setPulseAt(0);
    setPulsing(false);
    generatingRef.current = false;
  }, []);

  /**
   * 实现换了（用户在设置里存/清了自己的 Key）就作废当前会话。
   * contextId 是服务端内存里的会话，换实现等于换后端 —— 旧 id 在新后端里不存在，
   * 继续用只会一路 410。这里直接退回 URL 输入页，让他重新建立上下文。
   */
  const modeRef = useRef(agentMode);
  useEffect(() => {
    if (modeRef.current === agentMode) return;
    modeRef.current = agentMode;
    resetSession();
  }, [agentMode, resetSession]);

  /* ---------------- 提问模式 ---------------- */

  const sendAsk = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busy || phase !== 'ready') return;
      const history = messages;
      const answerId = uid('agent');
      /** 是否已经开始渲染正文（决定最后是「追加」还是「新建」气泡） */
      let started = false;
      const { onTrace, collected, clear } = makeTraceCollector();

      push({ id: uid('user'), role: 'user', kind: 'text', content: question, ts: Date.now() });
      setBusy(true);
      setStatus({ kind: 'thinking', text: 'Agent 正在思考…' });

      // 边收边渲染：第一段增量到达时才创建气泡，之前保持「思考中」占位
      const onDelta = (delta: string) => {
        if (!started) {
          started = true;
          push({ id: answerId, role: 'agent', kind: 'text', content: delta, ts: Date.now() });
          setStatus({ kind: 'thinking', text: '正在作答…' });
          return;
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === answerId && m.kind === 'text' ? { ...m, content: m.content + delta } : m,
          ),
        );
      };

      try {
        const result = await agent.ask(question, history, onDelta, onTrace);
        // 轨迹归档到这条回答上：实时面板收起来之后，用户仍能点开回看
        const trace = collected.length ? collected : undefined;
        if (started) {
          // 流式已渲染：用最终结果校正内容，并补上来源标签与思考过程
          setMessages((prev) =>
            prev.map((m) =>
              m.id === answerId && m.kind === 'text'
                ? { ...m, content: result.answer, sources: result.sources, trace }
                : m,
            ),
          );
        } else {
          push({
            id: answerId,
            role: 'agent',
            kind: 'text',
            content: result.answer,
            sources: result.sources,
            trace,
            ts: Date.now(),
          });
        }
        setStatus({ kind: 'success', text: '回答完成' });
      } catch (err) {
        fail(err);
        return;
      } finally {
        clear();
        setBusy(false);
      }
    },
    [agent, busy, fail, makeTraceCollector, messages, phase, push],
  );

  /* ---------------- 回答模式：出题 ---------------- */

  const requestNextQuestion = useCallback(
    async (type: QuestionType = questionType) => {
      if (generatingRef.current || phase !== 'ready') return;
      generatingRef.current = true;
      setBusy(true);
      setStatus({ kind: 'thinking', text: 'Agent 正在出题…' });
      const { onTrace, collected, clear } = makeTraceCollector();
      try {
        const history = messages;
        /*
         * 重试循环在前端（nextQuestionWithRetry），不在服务端：
         * 服务端每轮只跑一次尝试，前端逐轮驱动 —— 这样每一轮都能先把
         * 「上一版为什么不合格、我要换什么」讲给用户听。
         * 原来的服务端循环是静默的，运气差时用户要对着转圈等三轮模型调用。
         */
        const question: Question =
          type === 'choice'
            ? await agent.nextQuestionWithRetry('choice', history, onTrace)
            : await agent.nextQuestionWithRetry('short', history, onTrace);
        push({
          id: uid('q'),
          role: 'agent',
          kind: 'question',
          question,
          trace: collected.length ? collected : undefined,
          ts: Date.now(),
        });
        setQuestionCount((n) => n + 1);
        setStatus({ kind: 'success', text: '题目已生成' });
      } catch (err) {
        // 出题失败时轨迹留在面板上没意义：题目都没生成，没有可展开的载体
        fail(err);
        return;
      } finally {
        clear();
        generatingRef.current = false;
        setBusy(false);
      }
    },
    [agent, fail, makeTraceCollector, messages, phase, push, questionType],
  );

  /* ---------------- 回答模式：作答与判分 ---------------- */

  const patchQuestion = useCallback((messageId: string, patch: Partial<Question>) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId && m.kind === 'question'
          ? { ...m, question: { ...m.question, ...patch } as Question }
          : m,
      ),
    );
  }, []);

  const submitChoice = useCallback(
    async (messageId: string, selectedIndex: number) => {
      const target = messages.find((m) => m.id === messageId);
      if (!target || target.kind !== 'question') return;
      const question = target.question as ChoiceQuestion;
      if (question.submitted) return;

      // 先记录用户选择，再判分
      patchQuestion(messageId, { selectedIndex });
      push({
        id: uid('user'),
        role: 'user',
        kind: 'text',
        content: `我的选择：${String.fromCharCode(65 + selectedIndex)}. ${question.options[selectedIndex]}`,
        ts: Date.now(),
      });

      setBusy(true);
      setStatus({ kind: 'thinking', text: '正在判分…' });
      const { onTrace, clear } = makeTraceCollector();
      try {
        const grade = await agent.gradeChoice(question, selectedIndex, onTrace);
        patchQuestion(messageId, {
          submitted: true,
          correctIndex: grade.correctIndex,
          explanation: grade.explanation,
        });
        if (grade.correct) award();
        setStatus({
          kind: 'success',
          text: grade.correct ? `回答正确 · +${POINTS_PER_CORRECT} 分` : '回答错误',
        });
      } catch (err) {
        fail(err);
        return;
      } finally {
        clear();
        setBusy(false);
      }
    },
    [agent, award, fail, makeTraceCollector, messages, patchQuestion, push],
  );

  const submitShort = useCallback(
    async (messageId: string, answer: string) => {
      const text = answer.trim();
      const target = messages.find((m) => m.id === messageId);
      if (!target || target.kind !== 'question' || !text) return;
      const question = target.question as ShortQuestion;
      if (question.submitted) return;

      patchQuestion(messageId, { answer: text });
      push({ id: uid('user'), role: 'user', kind: 'text', content: text, ts: Date.now() });

      setBusy(true);
      setStatus({ kind: 'thinking', text: '正在批改…' });
      const { onTrace, clear } = makeTraceCollector();
      try {
        const grade = await agent.gradeShort(question, text, onTrace);
        patchQuestion(messageId, {
          submitted: true,
          score: grade.score,
          feedback: grade.feedback,
          reference: grade.reference,
        });
        // 简答题按 AI 给的分数计分：得几分加几分，满分即 POINTS_PER_CORRECT
        award(grade.score);
        setStatus({
          kind: 'success',
          text:
            grade.score > 0
              ? `得分 ${grade.score} / ${POINTS_PER_CORRECT} · +${grade.score} 分`
              : '得分 0 / 5 · 未得分',
        });
      } catch (err) {
        fail(err);
        return;
      } finally {
        clear();
        setBusy(false);
      }
    },
    [agent, award, fail, makeTraceCollector, messages, patchQuestion, push],
  );

  /**
   * 「给点提示」：只把引导文案挂到题目上。
   * 刻意不做的事 —— 不置 submitted、不计分、不写用户记忆（他还没作答，
   * 写进去会污染薄弱点统计，导致后续出题误判他「答错过」）。
   */
  const requestHint = useCallback(
    async (messageId: string) => {
      const target = messages.find((m) => m.id === messageId);
      if (!target || target.kind !== 'question') return;
      const question = target.question;
      // 已作答 / 已作废 / 已给过提示 —— 都没必要再要一次
      if (question.submitted === true || question.abandoned === true || question.hint) return;

      setBusy(true);
      setStatus({ kind: 'thinking', text: '正在生成提示…' });
      const { onTrace, clear } = makeTraceCollector();
      try {
        const hint = await agent.requestHint(question, onTrace);
        patchQuestion(messageId, { hint });
        setStatus({ kind: 'success', text: '已给出提示 · 只引导思路，不替代作答' });
      } catch (err) {
        fail(err);
        return;
      } finally {
        clear();
        setBusy(false);
      }
    },
    [agent, fail, makeTraceCollector, messages, patchQuestion],
  );

  /* ---------------- 分享回路 ---------------- */

  /**
   * 把这次会话里已出的选择题打包成一条可分享链接。
   *
   * 不在这个 hook 里管理弹层状态：它只是一个数据动作，
   * 「什么时候弹、弹成什么样」是纯 UI 决定，留在页面组件里更清楚。
   *
   * 也**不置 busy**：这个动作不调模型、毫秒级返回，
   * 把它算进 busy 会让整个界面（包括输入框）闪一下禁用态。
   */
  const shareQuiz = useCallback(() => agent.shareQuiz(), [agent]);

  /* ---------------- 模式 / 题型切换 ---------------- */

  const changeMode = useCallback(
    (next: ChatMode) => {
      if (next === mode) return;
      setMode(next);
      setStatus({ kind: 'idle', text: '' });
      if (next === 'ask') {
        pushNotice('已切换到「提问模式」，输入你的问题即可。');
        return;
      }
      // 还没选过题型：不替用户决定，也不提前开跑，先等他点题型
      if (!typeChosen) {
        pushNotice('已切换到「回答模式」，请先在上方选择题型（选择题 / 简答题），选定后我会立即出题。');
        return;
      }
      pushNotice(
        `已切换到「回答模式」，我将基于 URL 内容主动出题（当前题型：${questionType === 'choice' ? '选择题' : '简答题'}）。`,
      );
      // 若当前没有待作答的题目，立即出一题
      const hasPending = messages.some(isPendingQuestion);
      if (!hasPending) void requestNextQuestion(questionType);
    },
    [messages, mode, pushNotice, questionType, requestNextQuestion, typeChosen],
  );

  const changeQuestionType = useCallback(
    (next: QuestionType) => {
      // 已选过同一题型 → 不重复出题。首次选择时即使等于默认值也必须放行，
      // 否则「切到回答模式 → 点选择题」会因相等而被吞掉，页面永远停在无题状态。
      if (next === questionType && typeChosen) return;

      const label = next === 'choice' ? '选择题' : '简答题';
      const hasPending = messages.some(isPendingQuestion);
      const firstPick = !typeChosen;

      setQuestionType(next);
      setTypeChosen(true);

      if (hasPending) {
        // 上一题还没作答，直接留着只会让人困惑：作废它，另出一道新题型的题。
        setMessages((prev) =>
          prev.map((m) =>
            m.kind === 'question' && m.question.submitted !== true && m.question.abandoned !== true
              ? { ...m, question: { ...m.question, abandoned: true } as Question }
              : m,
          ),
        );
        pushNotice(`题型已切换为「${label}」，上一题尚未作答，已作废并重新出题。`);
      } else {
        pushNotice(firstPick ? `已选择题型「${label}」，正在出题…` : `题型已切换为「${label}」。`);
      }

      void requestNextQuestion(next);
    },
    [messages, pushNotice, questionType, requestNextQuestion, typeChosen],
  );

  /** 当前是否有等待作答的题目 */
  const pendingQuestionId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.kind !== 'question') continue;
      // 遇到已作答的题说明「当前题」已经翻篇，不再往前找
      if (m.question.submitted === true) break;
      if (m.question.abandoned === true) continue;
      return m.id;
    }
    return null;
  }, [messages]);

  return {
    phase,
    context,
    mode,
    agentMode,
    questionType,
    typeChosen,
    messages,
    status,
    busy,
    liveTrace,
    score,
    questionCount,
    pulsing,
    pendingQuestionId,
    initSession,
    resetSession,
    sendAsk,
    submitChoice,
    submitShort,
    requestHint,
    changeMode,
    changeQuestionType,
    requestNextQuestion,
    shareQuiz,
  };
}
