import { LINKS } from '@/lib/constants';

export function Footer() {
  return (
    <footer className="border-t border-[--hairline] bg-bg px-6 py-10 sm:px-10 lg:px-16">
      <div className="mx-auto flex max-w-[1200px] flex-col items-start gap-3 text-xs text-[--ink-faint] sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <span>&copy; 2026 whatSub</span>
          <a
            href={LINKS.icpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-[--ink-muted]"
          >
            {LINKS.icpRecord}
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <a
            href={LINKS.supportXhs}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-[--ink-muted]"
          >
            联系客服
          </a>
          <span>Terms</span>
          <span>Privacy</span>
        </div>
      </div>
    </footer>
  );
}
