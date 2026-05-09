'use client';

import { useReveal } from '@/hooks/useReveal';

export function FinalCTA() {
  const ref = useReveal<HTMLElement>();
  const scrollToDownload = () => {
    document.getElementById('download')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <section
      ref={ref}
      className="relative overflow-hidden bg-[--bg-soft] px-6 py-32 sm:px-10 lg:px-16"
    >
      {/* Subtle accent glow centered behind text */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[400px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background: 'radial-gradient(circle, var(--accent-glow), transparent 70%)',
          filter: 'blur(40px)',
        }}
      />
      <div className="relative mx-auto max-w-[900px] text-center">
        <h2
          className="reveal mb-6 font-display font-bold leading-[1.05] tracking-[-0.01em] text-ink"
          style={{ fontSize: 'clamp(48px, 8vw, 96px)' }}
        >
          开始 看 <span className="text-accent">字幕</span>。
        </h2>
        <p className="reveal reveal-delay-1 mx-auto mb-10 max-w-[560px] text-lg leading-[1.55] text-[--ink-soft]">
          下载 whatSub,把下一段看不懂的视频,变成下一句你会说的英语。
        </p>
        <button
          type="button"
          onClick={scrollToDownload}
          className="reveal reveal-delay-2 inline-flex h-14 items-center gap-2 rounded-lg bg-white px-8 text-base font-semibold text-bg transition-transform hover:-translate-y-0.5"
        >
          <span aria-hidden="true">⬇</span> 立即下载
        </button>
      </div>
    </section>
  );
}
