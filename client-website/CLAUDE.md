# client-website

Marketing + download landing page for whatSub at **`https://whatsub.eversay.cc/`**. Next.js 14 App Router + Tailwind, **static export** (`output: 'export'`) to plain HTML/CSS/JS. Served by enghub's nginx on the same Aliyun ECS as Eversay (no Node runtime in production — just static files).

> **Companion repos:**
> - License backend: [`rjxznb/whatsub-license`](https://github.com/rjxznb/whatsub-license) — Hono + Postgres on Node 20, exposes `/api/license/*`, `/admin/`, `/download/{win,mac}` on the same domain
> - Desktop app: `client/` (sibling in this repo) — Tauri 2

## Stack

| | |
|---|---|
| Framework | **Next.js 14 + App Router** (matches Eversay's stack) |
| Styling | **Tailwind v3** + brand-tokens-as-CSS-vars |
| Output | **Static export** (`output: 'export'`) → `out/` directory of HTML/CSS/JS, no Node runtime in prod |
| Fonts | **Self-hosted** Caveat (from `client/public/fonts/`) + Inter + JetBrains Mono (via `@fontsource/*`). NOT Google Fonts — fonts.googleapis.com is throttled/MITM'd in mainland China |
| Icons | `lucide-react` |
| TypeScript | strict, `noUncheckedIndexedAccess` |
| Deploy | scp tarball → in-place extract into `/data/whatsub-web/` (bind-mounted into enghub-nginx-1) |

## Layout

```
client-website/
├── package.json                # @whatsub/website, separate pnpm pkg
├── next.config.mjs             # output: 'export', images: { unoptimized: true }
├── tsconfig.json               # strict + paths "@/*": ["./src/*"]
├── tailwind.config.ts          # brand tokens (font-display: Caveat, accent: #3B9BFF)
├── postcss.config.mjs
├── .npmrc                      # registry=https://registry.npmmirror.com (taobao mirror)
├── .gitignore                  # node_modules/ .next/ out/ .env* *.log *.tsbuildinfo
├── public/
│   ├── fonts/Caveat-{Bold,Medium}.woff2     # byte-copied from client/public/fonts/
│   ├── favicon.ico                          # copied from client/src-tauri/icons/icon.ico
│   └── screenshots/{step-1..3,feature-*}.svg # 7 placeholder gray boxes — user swaps real GIFs/PNGs in
└── src/
    ├── app/
    │   ├── layout.tsx          # <html lang="zh"> + font preload + @fontsource imports
    │   ├── globals.css         # @font-face Caveat + brand CSS vars + body vignette + .reveal/.visible classes
    │   └── page.tsx            # Renders Nav + 8 sections + Footer in order
    ├── components/
    │   ├── Nav.tsx             # Fixed top, scroll-anchor menu, 购买授权 → 小红书
    │   ├── Hero.tsx            # Caveat signature "hey, whatSub?" + tagline + 2 download buttons + bilingual subtitle preview window
    │   ├── WhyCards.tsx        # 4-card grid: 本地转录/任意LLM/双语字幕/词汇本沉淀
    │   ├── HowSteps.tsx        # 3 alternating-side rows: 导入 → 本地识别 → 双语播放
    │   ├── FeatureGrid.tsx     # 4 hover-image cards: 词汇本/字幕导出/字幕编辑/黄底高亮
    │   ├── Download.tsx        # 2 platform tiles + version chip + GitHub backup link
    │   ├── Pricing.tsx         # Single-tier card → 小红书 store CTA
    │   ├── FAQ.tsx             # 7 expandable rows (chevron-rotate)
    │   ├── FinalCTA.tsx        # Closing band with smooth-scroll back to #download
    │   └── Footer.tsx          # © 2026 whatSub + ICP 备案号 + 联系客服
    ├── hooks/
    │   ├── useReveal.ts        # IntersectionObserver — adds .visible to .reveal items on scroll-in
    │   └── useLatestVersion.ts # fetch /api/license/latest → {version, pubDate, winUrl, macUrl} + fallback
    └── lib/
        └── constants.ts        # BRAND, LINKS (xhsStore, githubReleases, icpRecord), PRICING (¥99 placeholder)
```

## Brand tokens

Source of truth: `client/src/components/WelcomeIntro.tsx` (the desktop app's intro animation). Mirrored here as CSS variables in `globals.css` + Tailwind classes in `tailwind.config.ts` + TS exports in `lib/constants.ts`. **All three must agree** — if you change one, change all three.

| Token | Value | Usage |
|---|---|---|
| `--bg` / `bg-bg` | `#000000` | Page canvas |
| `--bg-soft` / `bg-bg-soft` | `#0a0a0c` | Alternating section bg (rhythm) |
| `--bg-elev` / `bg-bg-elev` | `#141418` | Cards |
| `--ink` / `text-ink` | `#ffffff` | Primary text |
| `--ink-soft` | `rgba(255,255,255,0.72)` | Body |
| `--ink-muted` | `rgba(255,255,255,0.48)` | Secondary |
| `--ink-faint` | `rgba(255,255,255,0.30)` | Timestamps / mono labels |
| `--accent` / `text-accent` | `#3B9BFF` | "Sub" wordmark, CTA buttons, single accent word per section title |
| `--accent-glow` | `rgba(59,155,255,0.35)` | text-shadow + buttons box-shadow |
| `--amber` / `text-amber` | `#FCD34D` | English highlight word underline (in subtitle preview) |

Font CSS classes: `font-display` = Caveat (handwriting headlines + section titles), `font-mono` = JetBrains Mono (timestamps, version chips), default = Inter sans (body).

Body has a layered radial vignette + 4%-opacity dotted grid (32px) baked into globals.css.

## Local dev

```bash
cd client-website
pnpm install              # via taobao mirror (.npmrc), ~30s
pnpm dev                  # http://localhost:3000 — hot reload
pnpm typecheck            # tsc --noEmit, must be clean
pnpm build                # → out/ (static export)
pnpm lint                 # next lint
```

In dev mode, `useLatestVersion()` will fail to fetch `/api/license/latest` (no backend on :3000) and fall back to a hardcoded `{version: '0.1.26', winUrl: null, macUrl: null}`. Production hits the live whatsub-license backend.

## Build + deploy

`pnpm build` produces a `out/` directory of static files. Deploy by copying those files into `/data/whatsub-web/` on the Aliyun server, which is bind-mounted into the enghub-nginx-1 container.

```bash
# Local
cd client-website
pnpm build
tar czf /tmp/whatsub-web.tar.gz -C out .

# Ship
scp -i ~/.ssh/id_ed25519 /tmp/whatsub-web.tar.gz root@47.93.87.206:/tmp/

# Apply on server (in-place extract — preserves directory inode)
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 "
  rm -rf /data/whatsub-web/* &&
  tar xzf /tmp/whatsub-web.tar.gz -C /data/whatsub-web/ &&
  rm /tmp/whatsub-web.tar.gz
"

# Verify
curl -sI https://whatsub.eversay.cc/ | head -3
```

**No nginx restart needed** for static-file replacement. The bind mount picks up filesystem changes live as long as the directory inode doesn't change (we extract in-place, not via mv-rename).

## Server topology

```
443 → enghub-nginx-1 (in /opt/enghub/docker-compose.yml)
       │
       ├ /api/license/*  → proxy_pass → whatsub-license:3002/api/* (Hono backend)
       ├ /download/*     → proxy_pass → whatsub-license:3002/download/*
       ├ /admin/*        → proxy_pass → whatsub-license:3002/admin/*
       └ /               → static file serve from /data/whatsub-web/  ← THIS PROJECT
```

nginx config lives at `/data/nginx-conf.d/whatsub.conf` (sibling to enghub's eversay.conf in the same shared directory). Source of truth: `whatsub-license/nginx/whatsub.conf` in the standalone whatsub-license repo (not in this repo — historical reason: the conf was authored alongside the license backend).

## Key design decisions (and why)

1. **Static export, not SSR.** The page is fully static — no per-request server work. Static export means we ship plain HTML/JS to nginx and avoid running a Node process in prod (saves the Aliyun box's 3.4 GB RAM for things that actually need it). Loses ISR/dynamic routes; we don't need those.

2. **Self-hosted fonts (NOT Google Fonts).** `fonts.googleapis.com` is throttled and sometimes MITM'd in mainland China — Chrome flagged the entire page as `不安全` because the third-party CSS request returned a cert error (some intermediate's MITM cert). Bundling fonts via `@fontsource/inter` + `@fontsource/jetbrains-mono` + the woff2 files we already have for Caveat sidesteps that. Adds ~1 MB to the bundle but it's served from the same mainland-direct nginx so the user doesn't notice.

3. **Caveat copied byte-for-byte from desktop app.** `public/fonts/Caveat-{Bold,Medium}.woff2` is a literal copy of `client/public/fonts/Caveat-{Bold,Medium}.woff2`. The wordmark in this site MUST be pixel-identical to the wordmark in the desktop app's WelcomeIntro animation — same hinting, same metrics, same rendering. Don't substitute another version of Caveat or use Google Fonts' Caveat (the file content differs).

4. **Brand tokens duplicated 3 ways** — Tailwind theme, CSS variables, TS exports. This is intentional: Tailwind enables `bg-accent` / `text-ink` shorthand, CSS vars enable arbitrary `style={{ ... }}` use + `--ink-soft` text colors, TS exports enable typed component code. All three need to stay in sync; the source of truth is `client/src/components/WelcomeIntro.tsx` lines 30-37.

5. **9 sections, 1 page, no routing.** The whole site is a single scrollable `page.tsx`. Nav menu items are anchor scrolls, not router pushes. Simpler than Next router for this use case + matches user's mental model (the buyer reads top-to-bottom).

6. **`useLatestVersion()` lives in the website, calls the license backend at `/api/license/latest`.** Same-origin so no CORS dance. Falls back to a hardcoded `0.1.26` on fetch error so the page never breaks even when the backend is down. The hardcoded value should be bumped alongside each release, but it's only a cosmetic fallback — the real version + URLs come from the live API.

7. **Placeholder screenshots are SVG, not PNG.** `public/screenshots/*.svg` is 7 gray-gradient boxes with labels in Chinese. SVG was chosen because it scales infinitely + tiny file size + doesn't need ImageMagick to generate. User swaps real PNG/GIF screenshots in later (keep the same filenames so it's a drop-in replacement).

8. **Deploy via in-place file replacement, NOT directory rename.** Past us tried `mv /data/whatsub-web /data/whatsub-web.old; mv whatsub-web.new whatsub-web` and broke the docker bind mount (container kept pointing at the old inode). The in-place extract (`rm -rf .../* && tar xzf ... -C .../`) preserves the directory inode so the bind mount stays valid. See deploy section above.

## Gotchas (we hit these; check first if a similar symptom shows up)

- **Chrome shows `此页面不安全 (HTTPS 连接断开)` despite valid cert.** Look at DevTools → Security tab. If it says "资源 - 出现证书错误的活动内容", the issue is a third-party HTTPS resource with cert error (Google Fonts in mainland China is the usual culprit). Fixed by self-hosting all fonts via `@fontsource/*`.

- **Build outputs `dist/src/index.js` instead of `dist/index.js`.** Different project, different Dockerfile — applies to whatsub-license, not this repo. But same root cause: tsc's auto-inferred `rootDir` from `include` glob. We don't use tsc to emit here (Next.js does the bundling), so this doesn't apply.

- **`tsconfig.tsbuildinfo` getting tracked by git.** TS incremental build cache file. Add `*.tsbuildinfo` to `.gitignore` (already done at PB5+1) and `git rm --cached client-website/tsconfig.tsbuildinfo` if it ever gets staged.

- **Atomic mv-rename breaks docker bind mounts.** Don't use `mv old new; mv new.tmp new` for the `/data/whatsub-web` deploy. Use in-place extract instead. (See deploy section.)

- **Hero animation not firing on second navigation.** `useReveal` uses `IntersectionObserver` with `unobserve` after first intersection. If the user scrolls the Hero out and back in, it stays visible (the `.visible` class persists). Intentional — re-firing the fade-in on every scroll-in is gimmicky.

- **Mobile layout: subtitle preview window stacks below text instead of side-by-side.** Intentional. We use `grid-cols-1` everywhere except a few places where `lg:grid-cols-2` kicks in at 1024px+. Side-by-side on phones makes the preview window unreadably small.

- **Section titles wrap onto 3 lines on narrow viewports.** Each title's font size uses `clamp(40px, 6vw, 72px)` — at 360px width it lands around 40px which is still big. Some Chinese titles wrap to 2-3 lines. Acceptable; alternatives (smaller min size, ellipsis, char-by-char animation) all looked worse.

- **`pnpm install` slow without taobao mirror.** `.npmrc` in this directory pins `registry=https://registry.npmmirror.com`. Don't delete it — the international npmjs registry is unreliable from mainland.

## Quick map

| Task | File |
|------|------|
| Tweak Hero copy / tagline | `src/components/Hero.tsx` (lines with `let me 一句字幕`) |
| Add an FAQ row | `src/components/FAQ.tsx` — append to `QUESTIONS` array |
| Change pricing | `src/lib/constants.ts` — `PRICING.amount` and `PRICING.features` |
| Change 小红书 store URL | `src/lib/constants.ts` — `LINKS.xhsStore` |
| Replace placeholder screenshots | drop real PNGs/GIFs into `public/screenshots/` (keep filenames) — rebuild + redeploy |
| Add a new section | new component in `src/components/` + import + render in `src/app/page.tsx` |
| Tune brand colors | edit all 3: `tailwind.config.ts` + `src/app/globals.css` + `src/lib/constants.ts` |
| Adjust scroll-reveal timing | `src/app/globals.css` (transition duration) + `src/hooks/useReveal.ts` (IntersectionObserver threshold/rootMargin) |

## What's NOT here (deliberately out of scope)

- English version (i18n hooks not wired; would need `next-intl` or similar)
- Real testimonials (none yet — placeholder block in spec was deleted)
- Founder story (overkill for desktop tool; cut from spec)
- Scenarios (Eversay-specific 18 scenes; doesn't apply to whatSub)
- Analytics
- A/B testing
- Direct payment / Stripe / Wechat Pay (purchase flows through 小红书 store link)
- CMS-driven content (everything is hard-coded — change the .tsx files)
