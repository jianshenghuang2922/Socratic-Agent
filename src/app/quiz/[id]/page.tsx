import type { Metadata } from 'next';
import { QuizRunner } from '@/components/QuizRunner';
import { getQuiz, toQuizView } from '@/server/quiz';

/**
 * 分享链接的落地页。
 *
 * 服务端渲染时就把题目取出来注入，不在客户端再拉一次 ——
 * 分享链接的第一印象就是「打开就有一道题」，中间夹一屏 loading 会把这个印象毁掉；
 * 而且链接过期（7 天）这种情况，只有首屏就能说清楚才不会让人以为是网络问题。
 *
 * 强制动态：测验存在进程内存里，任何缓存都会让刚生成的链接 404。
 */
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

/**
 * 站点级 OG 图。
 *
 * ⚠️ 必须在这里**显式写一遍**。根 layout 靠 `opengraph-image.png` 文件约定拿到图，
 * 但那个约定只作用于它所在的那一层路由；而子页面一旦自己设了 `openGraph`，
 * 整个对象是**整体替换**而不是深合并 —— 于是图就没了。
 * 症状很隐蔽：`og:title` 看着好好的，分享出去却是一张没有图的纯文字卡。
 * 实测确认过（`.tmp/probe-quiz-og.mjs`）。
 */
const OG_IMAGE = {
  url: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: 'Socratic Agent —— 我不是做题区！',
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const quiz = getQuiz(id);

  if (!quiz) {
    return { title: '测验链接已失效 · Socratic Agent' };
  }

  const count = quiz.questions.length;
  const title = `${count} 道题，考考你有没有真读懂《${quiz.title}》`;
  const description = '别人出的题，打开就能做。答完立刻给对错与解析。';

  return {
    title: `${title} · Socratic Agent`,
    description,
    alternates: { canonical: `/quiz/${id}` },
    openGraph: {
      type: 'website',
      locale: 'zh_CN',
      url: `/quiz/${id}`,
      siteName: 'Socratic Agent',
      title,
      description,
      images: [OG_IMAGE],
    },
    twitter: { card: 'summary_large_image', title, description, images: [OG_IMAGE.url] },
  };
}

/** 链接失效 / 过期：给一句能行动的话，而不是一个 404 页面 */
function Expired() {
  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">S</div>
          <div className="header-titles">
            <div className="header-title">Socratic Agent</div>
            <div className="header-sub">读网页与仓库，出题考你</div>
          </div>
        </div>
      </header>
      <main className="app-main app-main--gate">
        <div className="quiz-card quiz-card--result">
          <span className="card-tag">链接已失效</span>
          <h1 className="quiz-title">这个测验找不到了</h1>
          <p className="quiz-note">
            分享链接的有效期是 <strong>7 天</strong>，过期后题目会被清理。
            也可能是链接被截断或改动过。
          </p>
          <p className="quiz-fine">
            不如自己
            <a href="/"> 丢一个链接进去，让它给你出题</a>。
          </p>
        </div>
      </main>
    </div>
  );
}

export default async function QuizPage({ params }: Props) {
  const { id } = await params;
  const quiz = getQuiz(id);
  if (!quiz) return <Expired />;

  const view = toQuizView(quiz);

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">S</div>
          <div className="header-titles">
            <div className="header-title">Socratic Agent</div>
            <div className="header-sub">别人出的一套题</div>
          </div>
        </div>
        <div className="header-right">
          <a className="btn btn--ghost btn--sm" href="/">
            我也要出题
          </a>
        </div>
      </header>

      <main className="app-main app-main--quiz">
        <QuizRunner
          quizId={view.id}
          title={view.title}
          sourceUrl={view.sourceUrl}
          players={view.players}
          questions={view.questions}
        />
      </main>
    </div>
  );
}
