'use client';

import { Apple, Download as DownloadIcon, Github } from 'lucide-react';
import { useLatestVersion } from '@/hooks/useLatestVersion';
import { useReveal } from '@/hooks/useReveal';
import { LINKS } from '@/lib/constants';

const PLATFORMS = [
  {
    key: 'windows-x86_64' as const,
    label: 'Windows',
    sub: 'Win 10/11 · x64 · NSIS 安装包',
    href: '/download/win',
    githubAsset: 'whatsub_x64-setup.exe',
    Icon: DownloadIcon,
  },
  {
    key: 'darwin-aarch64' as const,
    label: 'macOS',
    sub: 'Apple Silicon · 已签名 + 公证',
    href: '/download/mac',
    githubAsset: 'whatsub_aarch64.dmg',
    Icon: Apple,
  },
];

function fmtPubDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function Download() {
  const latest = useLatestVersion();
  const ref = useReveal<HTMLElement>();

  const versionLine =
    latest?.version
      ? `当前最新版本 v${latest.version}${latest.pubDate ? ` · 发布于 ${fmtPubDate(latest.pubDate)}` : ''}`
      : '正在获取最新版本…';

  return (
    <section
      ref={ref}
      id="download"
      className="bg-bg px-6 py-24 sm:px-10 sm:py-32 lg:px-16"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2
          className="reveal mb-3 max-w-[900px] font-display font-bold leading-[1.05] tracking-[-0.01em] text-ink"
          style={{ fontSize: 'clamp(40px, 6vw, 72px)' }}
        >
          下载 <span className="text-accent">whatSub</span>
        </h2>
        <p className="reveal reveal-delay-1 mb-12 font-mono text-sm tracking-[0.02em] text-[--ink-muted]">
          {versionLine}
        </p>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {PLATFORMS.map((p, i) => (
            <div
              key={p.key}
              className={`reveal reveal-delay-${i + 1} flex flex-col rounded-xl border border-[--hairline] bg-[--bg-elev] p-8`}
            >
              <div className="mb-6 flex items-center gap-3">
                <p.Icon className="h-6 w-6 text-[--ink-soft]" strokeWidth={1.5} />
                <h3 className="font-display text-3xl font-bold leading-tight text-ink">
                  {p.label}
                </h3>
              </div>
              <p className="mb-7 text-sm text-[--ink-soft]">{p.sub}</p>
              <a
                href={p.href}
                className="mb-4 inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-white text-sm font-semibold text-bg transition-transform hover:-translate-y-px"
              >
                <span aria-hidden="true">⬇</span> 下载 v{latest?.version ?? '0.1.26'}
              </a>
              <a
                href={`${LINKS.githubReleases}/download/${p.githubAsset}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 font-mono text-xs text-[--ink-faint] transition-colors hover:text-[--ink-muted]"
              >
                <Github className="h-3.5 w-3.5" strokeWidth={1.5} /> GitHub 备用下载
              </a>
            </div>
          ))}
        </div>

        <p className="reveal reveal-delay-3 mt-8 text-center text-xs text-[--ink-faint]">
          Intel Mac 暂不支持 · ARM64 Windows 暂不支持 · 安装后首次激活需联网,激活后完全离线运行
        </p>
      </div>
    </section>
  );
}
