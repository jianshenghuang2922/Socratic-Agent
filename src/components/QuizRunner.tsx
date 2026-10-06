'use client';

import { useCallback, useState } from 'react';
import { copyText } from '@/lib/clipboard';
import { gradeSharedQuestion } from '@/lib/quizClient';
import type { SharedQuestion, SharedQuizGrade } from '@/lib/types';

interface Props {
  quizId: string;
  title: string;
  sourceUrl: string;
  /** 已有多少人做过（服务端渲染时快照，页面内不再刷新） */
  players: number;
  questions: SharedQuestion[];
}

const LETTERS = 'ABCDEFGH';

/** 按正确率给一句人话 —— 比「你答对了 6 题」多给一点行动指向 */
function verdictText(correct: number, total: number): string {
  if (total === 0) return '';
  const ratio = correct / total;
  if (ratio === 1) return '全对。这套链接里的东西你是真读进去了。';
  if (ratio >= 0.8) return '很稳。只漏了个别细节，回头补一下就够了。';
  if (ratio >= 0.5) return '及格线上。错的那几处正好是原文里最容易被跳过的地方。';
  return '这套题不太友好 —— 但错的那几道，恰恰是最值得回头看一眼原文的。';
}

/**
 * 做题器 —— 分享链接落地页的全部交互。
 *
 * 一次只出一题、答完立刻判：判分是服务端整数比对，零延迟零成本，
 * 所以没有理由攒到最后一起判。即时反馈也是这套东西能被做完的唯一原因 ——
 * 攒成一整张试卷，没人愿意做第二题。
 *
 * 题目由服务端渲染时注入（见 app/quiz/[id]/page.tsx），这里不自己取题：
 * 省掉一次往返与一整屏 loading，也让「链接已过期」能在首屏就说清楚。
 */
export function QuizRunner({ quizId, title, sourceUrl, players, questions }: Props) {
  const [phase, setPhase] = useState<'intro' | 'playing' | 'done'>('intro');
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [grade, setGrade] = useState<SharedQuizGrade | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  /** 逐题结果，用于最后算总分 */
  const [results, setResults] = useState<boolean[]>([]);
  const [copied, setCopied] = useState(false);

  const question = questions[index];
  const total = questions.length;
  const correctCount = results.filter(Boolean).length;

  const submit = useCallback(async () => {
    if (picked === null || pending || grade || !question) return;
    setPending(true);
    setError('');
    try {
      const result = await gradeSharedQuestion(quizId, question.id, picked);
      setGrade(result);
      setResults((prev) => [...prev, result.correct]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, [grade, picked, pending, question, quizId]);

  const next = useCallback(() => {
    if (index + 1 >= total) {
      setPhase('done');
      return;
    }
    setIndex((i) => i + 1);
    setPicked(null);
    setGrade(null);
    setError('');
  }, [index, total]);

  const restart = useCallback(() => {
    setPhase('playing');
    setIndex(0);
    setPicked(null);
    setGrade(null);
    setError('');
    setResults([]);
  }, []);

  const copyLink = useCallback(async () => {
    const url = `${window.location.origin}/quiz/${quizId}`;
    const ok = await copyText(url);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      return;
    }
    window.prompt('复制这条链接发给别人：', url);
  }, [quizId]);

  /* ---------------- 开场 ---------------- */

  if (phase === 'intro') {
    return (
      <div className="quiz-card">
        <span className="card-tag">分享测验</span>
        <h1 className="quiz-title">{title}</h1>
        <p className="quiz-sub">
          {total} 道选择题
          {players > 0 && ` · 已有 ${players} 人做过`}
        </p>
        <p className="quiz-note">
          题目锚定原文里<strong>真实存在</strong>的段落与函数，不是泛泛的常识题。
          答完立刻给对错与解析。
        </p>
        <a className="quiz-source" href={sourceUrl} target="_blank" rel="noreferrer noopener">
          原文：{sourceUrl}
        </a>
        <div className="quiz-actions">
          <button
            type="button"
            className="btn btn--primary btn--lg"
            onClick={() => setPhase('playing')}
          >
            开始答题
          </button>
        </div>
      </div>
    );
  }

  /* ---------------- 成绩 ---------------- */

  if (phase === 'done') {
    return (
      <div className="quiz-card quiz-card--result">
        <span className="card-tag">成绩</span>
        <div className="quiz-score-big">
          <span className="quiz-score-num">{correctCount}</span>
          <span className="quiz-score-den">/ {total}</span>
        </div>
        <p className="quiz-verdict">{verdictText(correctCount, total)}</p>
        <p className="quiz-sub">
          来自《{title}》
          {players > 0 && ` · 共 ${players} 人做过`}
        </p>

        <div className="quiz-actions">
          <button type="button" className="btn btn--primary" onClick={copyLink}>
            {copied ? '已复制 ✓' : '复制链接，考考别人'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={restart}>
            再做一遍
          </button>
        </div>

        <p className="quiz-fine">
          把链接发出去，看别人能答对几道。也可以
          <a href="/"> 丢一个自己的链接让它出题</a>。
        </p>
      </div>
    );
  }

  /* ---------------- 答题中 ---------------- */

  if (!question) return null;

  const optionClass = (i: number) => {
    if (!grade) return picked === i ? 'option option--picked' : 'option';
    if (i === grade.correctIndex) return 'option option--correct';
    if (i === picked) return 'option option--wrong';
    return 'option';
  };

  return (
    <div className="quiz-card">
      <div className="quiz-progress">
        <span className="quiz-progress__text">
          第 {index + 1} / {total} 题
        </span>
        <div className="quiz-bar">
          <div
            className="quiz-bar__fill"
            style={{ width: `${((index + (grade ? 1 : 0)) / total) * 100}%` }}
          />
        </div>
        <span className="quiz-progress__score">已答对 {correctCount}</span>
      </div>

      <p className="card-prompt">{question.prompt}</p>

      <div className="options">
        {question.options.map((opt, i) => (
          <button
            key={i}
            type="button"
            className={optionClass(i)}
            disabled={Boolean(grade)}
            onClick={() => setPicked(i)}
          >
            <span className="option-key">{LETTERS[i] ?? i + 1}</span>
            <span className="option-text">{opt}</span>
            {grade && i === grade.correctIndex && <span className="option-mark">✓</span>}
            {grade && i === picked && i !== grade.correctIndex && (
              <span className="option-mark option-mark--wrong">✕</span>
            )}
          </button>
        ))}
      </div>

      {question.sources && question.sources.length > 0 && (
        <div className="quiz-sources">
          依据：{question.sources.slice(0, 3).join(' · ')}
        </div>
      )}

      {grade && (
        <div className="card-result">
          <span className={`verdict ${grade.correct ? 'verdict--ok' : 'verdict--bad'}`}>
            {grade.correct ? '✓ 答对了' : '✕ 答错了'}
          </span>
          {grade.explanation && <p className="quiz-explanation">{grade.explanation}</p>}
        </div>
      )}

      {error && <div className="field-error quiz-error">{error}</div>}

      <div className="card-actions">
        {grade ? (
          <button type="button" className="btn btn--primary" onClick={next}>
            {index + 1 >= total ? '看成绩' : '下一题'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={picked === null || pending}
          >
            {pending ? '判分中…' : '提交答案'}
          </button>
        )}
      </div>
    </div>
  );
}
