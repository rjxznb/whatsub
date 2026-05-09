'use client';

import Link from 'next/link';
import { useLatestVersion } from '@/hooks/useLatestVersion';
import { useReveal } from '@/hooks/useReveal';

export function Hero() {
  const latest = useLatestVersion();
  const containerRef = useReveal<HTMLDivElement>();

  const versionLabel = latest?.version
    ? `v${latest.version} · macOS Apple Silicon & Windows 10/11`
    : 'macOS Apple Silicon & Windows 10/11';

  return (
    <section
      ref={containerRef}
      id="top"
      className="relative overflow-hidden px-6 pt-32 pb-24 sm:px-10 lg:px-16 lg:pt-40 lg:pb-32"
    >
      <div className="mx-auto max-w-[1200px] text-center">
        {/* eyebrow */}
        <div className="reveal mb-10 inline-flex items-center gap-2 rounded-full border border-[--hairline-strong] bg-white/[0.04] px-4 py-[7px] font-mono text-xs tracking-[0.02em] text-[--ink-soft]">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-[#4ade80]"
            style={{ boxShadow: '0 0 8px rgba(74,222,128,0.6)' }}
            aria-hidden="true"
          />
          <span>{versionLabel}</span>
        </div>

        {/* signature */}
        <h1
          className="reveal reveal-delay-1 mb-7 font-display font-bold leading-none tracking-[-0.01em] text-ink"
          style={{ fontSize: 'clamp(64px, 12vw, 130px)' }}
        >
          hey,&nbsp;what
          <span
            className="text-accent"
            style={{ textShadow: '0 0 32px var(--accent-glow)' }}
          >
            Sub
          </span>
          ?
        </h1>

        {/* tagline */}
        <p className="reveal reveal-delay-2 mx-auto mb-10 max-w-[640px] text-[clamp(16px,2vw,22px)] leading-[1.55] text-[--ink-soft]">
          让一句字幕，慢慢成为你的英语。
        </p>

        {/* actions */}
        <div className="reveal reveal-delay-3 mb-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/download/win"
            className="inline-flex h-12 items-center gap-2 rounded-lg bg-white px-7 text-sm font-semibold text-bg transition-transform hover:-translate-y-px"
          >
            <span aria-hidden="true">⬇</span> Windows 下载
          </Link>
          <Link
            href="/download/mac"
            className="inline-flex h-12 items-center gap-2 rounded-lg border border-[--hairline-strong] bg-white/[0.04] px-7 text-sm font-semibold text-ink transition-transform hover:-translate-y-px"
          >
            <span aria-hidden="true">⬇</span> macOS 下载
          </Link>
        </div>

        {/* meta */}
        <div className="reveal reveal-delay-3 mb-20 font-mono text-xs tracking-[0.04em] text-[--ink-faint]">
          100% 本地运行 · 不上传任何视频
        </div>

        {/* preview window */}
        <div
          className="reveal reveal-delay-4 mx-auto max-w-[880px] rounded-2xl bg-[--bg-elev] p-3"
          style={{
            boxShadow:
              '0 0 0 1px rgba(255,255,255,0.04), 0 60px 120px -20px rgba(0,0,0,0.8), 0 0 80px rgba(59,155,255,0.06)',
          }}
        >
          {/* chrome */}
          <div className="flex items-center gap-3 px-1 pb-3 pt-2">
            <div className="flex gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
              <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
              <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
            </div>
            <span className="font-mono text-[11px] tracking-[0.05em] text-[--ink-faint]">
              whatSub — Friends_S01E03.mp4
            </span>
          </div>

          {/* body */}
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl bg-[--hairline] sm:grid-cols-[1.4fr_1fr]">
            {/* video pane */}
            <div
              className="relative flex min-h-[200px] items-center justify-center sm:min-h-[280px]"
              style={{
                background:
                  'linear-gradient(135deg, #1a1a20 0%, #0a0a0c 100%)',
              }}
            >
              <div
                className="flex h-16 w-16 items-center justify-center rounded-full bg-white/[0.06] text-[32px] text-[--ink-faint]"
                aria-hidden="true"
              >
                ▶
              </div>
              <span className="absolute bottom-3 left-3 font-mono text-[10px] tracking-[0.1em] text-[--ink-faint]">
                03:42 / 22:18
              </span>
            </div>

            {/* captions pane */}
            <div className="bg-[--bg-elev] px-5 py-4 text-left">
              {[
                {
                  ts: '03:38 → 03:42',
                  active: false,
                  en: ['I told you it was gonna ', { hl: 'work out' }, '.'],
                  zh: ['我跟你说过会', { hl: '成的' }, '。'],
                },
                {
                  ts: '03:42 → 03:46',
                  active: true,
                  en: [
                    'The trick is to ',
                    { hl: 'break it down' },
                    ' into smaller pieces.',
                  ],
                  zh: ['诀窍是把它', { hl: '拆解' }, '成更小的部分。'],
                },
                {
                  ts: '03:46 → 03:51',
                  active: false,
                  en: [
                    'Once you do that, the rest pretty much ',
                    { hl: 'falls into place' },
                    '.',
                  ],
                  zh: ['一旦这样做，剩下的就基本', { hl: '水到渠成' }, '了。'],
                },
              ].map((cue, i) => (
                <div
                  key={i}
                  className={
                    'border-b border-[--hairline] py-2.5 last:border-b-0 ' +
                    (cue.active
                      ? '-mx-5 border-l-2 border-l-accent bg-accent/[0.06] pl-[18px] pr-5'
                      : '')
                  }
                >
                  <div className="mb-1 font-mono text-[10px] text-[--ink-faint]">
                    {cue.ts}
                  </div>
                  <div className="mb-1 text-[13px] leading-snug text-ink">
                    {cue.en.map((part, idx) =>
                      typeof part === 'string' ? (
                        <span key={idx}>{part}</span>
                      ) : (
                        <span
                          key={idx}
                          className="border-b-[1.5px] border-amber bg-amber/20 px-0.5"
                        >
                          {(part as { hl: string }).hl}
                        </span>
                      ),
                    )}
                  </div>
                  <div
                    className="text-[12px] leading-snug text-[--ink-muted]"
                    style={{ fontFamily: "'PingFang SC', 'Source Han Sans SC', sans-serif" }}
                  >
                    {cue.zh.map((part, idx) =>
                      typeof part === 'string' ? (
                        <span key={idx}>{part}</span>
                      ) : (
                        <span key={idx} className="text-amber">
                          {(part as { hl: string }).hl}
                        </span>
                      ),
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
