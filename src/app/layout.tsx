import type { Metadata, Viewport } from 'next';
import { BackgroundVideo } from '@/components/BackgroundVideo';
import './globals.css';

/**
 * OG / canonical 需要绝对地址，所以必须有一个站点根。
 * 换域名时设 NEXT_PUBLIC_SITE_URL，不用改代码。
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://socratic-agent-th9l.onrender.com';

/**
 * 标题卖结果，不卖品类。「基于 URL 的智能问答」没人搜也没人点。
 *
 * ⚠️ 品牌钩子「我不是做题区！」只放**视觉位**（首屏 h1 + 分享卡片图）；
 * metadata 保持**可被搜索**的描述性文案 —— 钩子没人搜，塞进 <title> 等于丢流量。
 */
const TAGLINE = '读网页与仓库，出题考你';
const BLURB = '粘贴一个网页或代码仓库的地址，结合费曼学习法向它提问、作答，也可以让它出题考你。';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Socratic Agent · 读网页与仓库，出题考你',
  description:
    '粘贴一个网页或代码仓库的地址，结合费曼学习法向它提问、作答，也可以让它出题考你：选择题或简答题的题干锚定原文里真实存在的段落与函数，答错的题会成为后续出题的靶子。',
  applicationName: 'Socratic Agent',
  alternates: { canonical: '/' },
  // 分享卡片的图片由 src/app/opengraph-image.png 提供（文件约定会自动注入 og:image）。
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    url: '/',
    siteName: 'Socratic Agent',
    title: TAGLINE,
    description: BLURB,
  },
  twitter: {
    card: 'summary_large_image',
    title: TAGLINE,
    description: BLURB,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#05070f',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <BackgroundVideo />
        {children}
      </body>
    </html>
  );
}
