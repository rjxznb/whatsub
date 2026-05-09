import type { Metadata } from 'next';
// Self-host JetBrains Mono via @fontsource (used for version chips +
// timestamps). Inter dropped — body sans now uses the OS native font
// stack (system-ui → Microsoft YaHei UI / PingFang SC etc.) so Chinese
// chars match Latin chars with the same metrics, and we avoid the
// Google Fonts CDN cert-error issue in mainland China.
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'whatSub — 让一句字幕，慢慢成为你的英语',
  description:
    '把 YouTube 视频变成你的英语课：本地 Whisper 转录、双语字幕、关键短语高亮、词汇本沉淀，100% 离线运行',
  icons: { icon: '/favicon.ico' },
  openGraph: {
    title: 'whatSub',
    description: '让一句字幕，慢慢成为你的英语',
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
      </head>
      <body>{children}</body>
    </html>
  );
}
