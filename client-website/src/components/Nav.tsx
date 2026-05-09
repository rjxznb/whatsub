'use client';
import { useEffect, useState } from 'react';
import { LINKS } from '@/lib/constants';

const NAV_LINKS = [
  { id: 'why', label: '功能' },
  { id: 'download', label: '下载' },
  { id: 'pricing', label: '定价' },
  { id: 'faq', label: 'FAQ' },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

  return (
    <nav
      className={`fixed inset-x-0 top-0 z-50 transition-[backdrop-filter,border-color] duration-200 ${
        scrolled
          ? 'border-b border-[--hairline] bg-bg/85 backdrop-blur-lg'
          : 'border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6 sm:px-10 lg:px-16">
        <a href="#top" className="flex items-baseline font-display text-[28px] font-bold leading-none tracking-tight">
          <span>what</span>
          <span className="text-accent" style={{ textShadow: '0 0 24px var(--accent-glow)' }}>Sub</span>
          <span>?</span>
        </a>
        <div className="flex items-center gap-7">
          <ul className="hidden md:flex items-center gap-7 text-sm text-[--ink-soft]">
            {NAV_LINKS.map((l) => (
              <li key={l.id}>
                <button
                  onClick={() => scrollTo(l.id)}
                  className="transition-colors hover:text-ink"
                >
                  {l.label}
                </button>
              </li>
            ))}
          </ul>
          <a
            href={LINKS.xhsStore}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-transform hover:scale-[1.02]"
            style={{ boxShadow: '0 0 0 1px rgba(59,155,255,0.4), 0 0 24px var(--accent-glow)' }}
          >
            购买授权
          </a>
        </div>
      </div>
    </nav>
  );
}
