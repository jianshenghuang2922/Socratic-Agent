import type { Metadata, Viewport } from 'next';
import { BackgroundVideo } from '@/components/BackgroundVideo';
import './globals.css';

export const metadata: Metadata = {
  title: 'Socratic Agent · 基于 URL 的智能问答',
  description: '输入网页或仓库 URL 建立问答上下文，支持提问模式与回答模式的双向问答 Agent。',
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
