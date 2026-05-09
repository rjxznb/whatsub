'use client';

import { Check, ShoppingBag } from 'lucide-react';
import { useReveal } from '@/hooks/useReveal';
import { LINKS, PRICING } from '@/lib/constants';

export function Pricing() {
  const ref = useReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      id="pricing"
      className="bg-[--bg-soft] px-6 py-24 sm:px-10 sm:py-32 lg:px-16"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2
          className="reveal mb-14 max-w-[900px] font-display font-bold leading-[1.05] tracking-[-0.01em] text-ink"
          style={{ fontSize: 'clamp(40px, 6vw, 72px)' }}
        >
          一份授权,<span className="text-accent">3 台设备</span>。
        </h2>

        <div
          className="reveal reveal-delay-1 mx-auto max-w-[480px] rounded-2xl border border-[--hairline-strong] bg-[--bg-elev] p-8 sm:p-10"
          style={{ boxShadow: '0 0 80px rgba(59,155,255,0.05)' }}
        >
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-[--ink-faint]">
            授权方式
          </p>

          <div className="mb-3 flex items-baseline gap-2">
            <span className="font-display text-7xl font-bold leading-none text-ink">
              {PRICING.amount}
            </span>
            {PRICING.period ? (
              <span className="font-display text-2xl text-[--ink-faint]">
                {PRICING.period}
              </span>
            ) : null}
          </div>
          <p className="mb-8 text-sm text-[--ink-soft]">{PRICING.label}</p>

          <ul className="mb-8 space-y-3">
            {PRICING.features.map((f) => (
              <li key={f} className="flex items-start gap-3 text-sm text-[--ink-soft]">
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                  <Check className="h-3 w-3" strokeWidth={2.5} />
                </span>
                <span>{f}</span>
              </li>
            ))}
          </ul>

          <a
            href={LINKS.xhsStore}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-white transition-transform hover:-translate-y-px"
            style={{ boxShadow: '0 0 0 1px rgba(59,155,255,0.4), 0 0 32px var(--accent-glow)' }}
          >
            <ShoppingBag className="h-4 w-4" strokeWidth={2} /> 在小红书购买
          </a>

          <p className="mt-4 text-center text-xs text-[--ink-faint]">
            数字商品售出不退,购买前可先试用免费档位
          </p>
        </div>
      </div>
    </section>
  );
}
