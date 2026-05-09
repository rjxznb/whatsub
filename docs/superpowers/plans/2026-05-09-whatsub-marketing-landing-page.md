# whatSub Marketing Landing Page — Implementation Plan

> **Status (2026-05-09): IN PROGRESS.** Plan A (license backend → Aliyun) finished + deployed; this Plan B builds the marketing site that lives at `https://whatsub.eversay.cc/` (currently a 1-section placeholder).

**Goal:** Build the 9-section Next.js 14 static-export marketing site spec'd in `docs/superpowers/specs/2026-05-09-whatsub-landing-page-design.md` §3-§5, deploy it to `/data/whatsub-web/` on the Eversay Aliyun ECS, replacing the temporary placeholder hero.

**Architecture:** Standalone `client-website/` Next.js 14 app router project, Tailwind v3, static export (`output: 'export'`), self-hosted Caveat font from `client/public/fonts/`, brand tokens from `client/src/components/WelcomeIntro.tsx`. Build outputs to `out/`, tarred and scp'd to host volume `/data/whatsub-web/` (already mounted into enghub's nginx).

**Tech stack:** Next.js 14 + App Router, Tailwind v3, TypeScript strict, `@fontsource/inter`, JetBrains Mono via Google Fonts (loaded once), Caveat self-hosted (file-copied from `client/public/fonts/`), `lucide-react` icons. No vendor SDKs, no LLM, no analytics at launch.

**Reference docs:**
- Spec (single source of truth for visual + content): [`docs/superpowers/specs/2026-05-09-whatsub-landing-page-design.md`](../specs/2026-05-09-whatsub-landing-page-design.md), §3-§5
- Brand tokens (verbatim copy): `client/src/components/WelcomeIntro.tsx` lines 30–37
- Hero visual reference: `.superpowers/brainstorm/9226-1778280078/content/hero-whatsub-brand.html`
- Eversay landing for visual + animation patterns to selectively port: `Enghub/apps/web/src/app/page.tsx` + `Enghub/apps/web/src/components/landing/HeroAnimation.tsx`

---

## Phase 1 — Project scaffold + brand

### Task PB1: Scaffold + Nav + Footer + globals.css

**Files (create):**
- `client-website/package.json`, `next.config.mjs`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.mjs`, `.gitignore`, `.npmrc`, `README.md`
- `client-website/public/fonts/Caveat-{Bold,Medium}.woff2` (copy from `client/public/fonts/`)
- `client-website/public/favicon.ico` (copy from `client/src-tauri/icons/icon.ico`)
- `client-website/src/app/{layout.tsx,globals.css}`
- `client-website/src/lib/constants.ts` — brand tokens as TS exports
- `client-website/src/components/{Nav,Footer}.tsx`

Brand tokens: black canvas `#000000`, ink white `#ffffff`, accent Sub-blue `#3B9BFF`, hairline `rgba(255,255,255,0.14)`, soft surface `#0a0a0c`, elevated `#141418`. radial vignette identical to WelcomeIntro.

`globals.css`: brand CSS variables, `@font-face` for Caveat, base body styles (vignette + grid texture).

`Nav`: fixed top, logo `whatSub?` (Caveat 32px, Sub blue), inline menu (功能/下载/定价/FAQ as anchor scrollers), 「购买授权」button (links to 小红书 store URL — placeholder `https://www.xiaohongshu.com/user/profile/<USER_ID>` — user fills in real one later via lib/constants.ts).

`Footer`: `© 2026 whatSub` + ICP `京ICP备2026014893号-1` + 联系客服(小红书 link) + Terms + Privacy. Pure `--bg`, 12px mono, `--ink-faint`.

---

## Phase 2 — Hero + hooks

### Task PB2: Hero + useLatestVersion + useReveal

**Files (create):**
- `client-website/src/hooks/useLatestVersion.ts` — fetches `/api/license/latest`, exposes `{version, pubDate, winUrl, macUrl}`, falls back to `{version: '0.1.26', ...}` on error
- `client-website/src/hooks/useReveal.ts` — IntersectionObserver scroll-reveal (port from `Enghub/apps/web/src/app/page.tsx` `useReveal` hook)
- `client-website/src/components/Hero.tsx` — see spec §5.2

Hero copy locked: signature `hey, what<span>Sub</span>?`, tagline `让一句字幕，慢慢成为你的英语。`, eyebrow chip with mono caption `v{version} · macOS Apple Silicon & Windows 10/11` + green status dot, two buttons (`⬇ Windows 下载` white-bg primary, `⬇ macOS 下载` ghost secondary), mono meta `100% 本地运行 · 不上传任何视频`. Below: a fake app preview window (right side at desktop, below at mobile) with bilingual subtitle rows + amber yellow highlight on key phrases — same as the brainstorm mock.

Buttons link to `/download/{win,mac}` (302 redirects already deployed; same-origin so relative).

---

## Phase 3 — Mid-page sections

### Task PB3: WhyCards + HowSteps + FeatureGrid

**Files (create):**
- `client-website/src/components/WhyCards.tsx` — 4-card grid, see spec §5.3 for content
- `client-website/src/components/HowSteps.tsx` — 3 alternating screenshot rows, see spec §5.4
- `client-website/src/components/FeatureGrid.tsx` — 4-card hover-image-overlay pattern, see spec §5.5
- `client-website/public/screenshots/` — placeholder 2:1 gray boxes (640x320 PNGs labeled "step-1.png", "step-2.png", "step-3.png", "feature-vocab.png", "feature-export.png", "feature-edit.png", "feature-highlight.png"). User swaps real screenshots later.

Section title font: Caveat 56–80px responsive. All cards on `--bg-elev` with hairline border. Surface rhythm: Why on `--bg-soft`, How on `--bg`, Features on `--bg-soft` (alternating).

---

## Phase 4 — Bottom sections

### Task PB4: Download + Pricing + FAQ + FinalCTA

**Files (create):**
- `client-website/src/components/Download.tsx` — see spec §5.6, two big platform tiles (Windows / macOS Apple Silicon), version + size pulled from `useLatestVersion`, secondary "GitHub 备用" link below each
- `client-website/src/components/Pricing.tsx` — single tier, ¥XX placeholder, 5-line feature checklist, big CTA → 小红书 store, see spec §5.7
- `client-website/src/components/FAQ.tsx` — 7 expandable rows (chevron-rotate on click), see spec §5.8 for the 7 questions
- `client-website/src/components/FinalCTA.tsx` — Caveat 80px `开始 看 字幕。`, single download button that smooth-scrolls back up to the Download section

---

## Phase 5 — Wire + deploy

### Task PB5: page.tsx assembly + next.config.mjs + build + ship

**Files (create):**
- `client-website/src/app/page.tsx` — imports + renders all 10 components (Nav + Hero + 8 sections + Footer)
- `client-website/next.config.mjs` — `output: 'export'`, `images: { unoptimized: true }`
- `client-website/.gitignore` — node_modules, out, .next

**Deploy:**
1. `cd client-website && pnpm install && pnpm build`
2. Verify `out/` produced, contains `index.html`
3. `tar czf /tmp/whatsub-web.tar.gz -C out .`
4. `scp` to server `/tmp/`
5. SSH: extract into `/data/whatsub-web/` (atomic via `.new` rename, keep old as `.bak` until verified)
6. `curl https://whatsub.eversay.cc/` → 200 + new content
7. Visual smoke check via `curl -s https://whatsub.eversay.cc/ | grep -E 'whatSub|hey|长出'`

**No code rebuild on server** — static files, just file replacement.

---

## Out of scope for this plan

- English version (i18n hooks placeholders left in code but only Chinese strings)
- Real screenshots/GIFs (user provides; placeholders ship)
- Real ¥XX price (user fills in `lib/constants.ts` → `PRICING.amount`)
- Real 小红书 store URL (user fills in `lib/constants.ts` → `LINKS.xhsStore`)
- Analytics
- A/B testing infra
- Eversay HeroAnimation port — too animation-heavy for v1; we use a static signature with subtle CSS animations instead

## Success criteria

- `https://whatsub.eversay.cc/` returns 200 with the 9-section site
- Page interactive in <1s on mainland 4G (no VPN)
- Download buttons end-to-end work (302 → jihulab download starts)
- `购买授权` CTA opens 小红书 store in new tab
- All sections render correctly at 360 / 768 / 1024 / 1440 viewport widths
- `useLatestVersion` populates the eyebrow + Download tile version chip within 500ms
- pnpm build + static export both clean, no errors
