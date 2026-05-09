import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'whatSub — 让一句字幕，慢慢成为你的英语',
  description:
    '把 YouTube 视频变成你的英语课：本地 Whisper 转录、双语字幕、关键短语高亮、词汇本沉淀。100% 离线运行。',
  icons: { icon: '/favicon.ico' },
  openGraph: {
    title: 'whatSub',
    description: '让一句字幕，慢慢成为你的英语。',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh">
      <head>
        <link
          rel="preload"
          href="/fonts/Caveat-Bold.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
