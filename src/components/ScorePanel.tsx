'use client';

interface Props {
  /** 累计得分 */
  score: number;
  /** 累计出题数 */
  questionCount: number;
  /** 得分刚发生变化时为 true，用于触发一次高亮 */
  pulsing: boolean;
}

/** 得分模块：回答模式下每答对一题 +5 分，并累计出题数 */
export function ScorePanel({ score, questionCount, pulsing }: Props) {
  return (
    <div
      className={`score ${pulsing ? 'score--pulse' : ''}`}
      role="status"
      aria-live="polite"
      title="回答模式下每答对一题得 5 分"
    >
      <svg className="score-star" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 2.6l2.86 6.02 6.54.86-4.8 4.5 1.24 6.42L12 17.34 6.16 20.4l1.24-6.42-4.8-4.5 6.54-.86z"
          fill="currentColor"
        />
      </svg>

      <div className="score-item">
        <span className="score-label">得分</span>
        <span className="score-value score-value--accent">{score}</span>
      </div>

      <span className="score-sep" />

      <div className="score-item">
        <span className="score-label">题目</span>
        <span className="score-value">{questionCount}</span>
      </div>
    </div>
  );
}
