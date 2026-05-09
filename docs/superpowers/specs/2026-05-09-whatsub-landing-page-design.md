# whatSub Landing Page — Design Spec

- **Date**: 2026-05-09
- **Author**: 家兴
- **Status**: Draft → awaiting review (revised after Aliyun infra context)
- **Scope**: Marketing/download website for the whatSub desktop app **AND** consolidation of the existing CF-Workers license backend onto the same domain. Both deploy to the existing Eversay Aliyun ECS at `47.93.87.206`, exposed at `https://whatsub.eversay.cc`.

> **Note (post-implementation, 2026-05-09):** the license-backend half of this spec has been built and deployed. The code now lives in a separate repo at **[`github.com/rjxznb/whatsub-license`](https://github.com/rjxznb/whatsub-license)** — references in this doc to `whatsub-license/` paths are historical (during implementation those files lived in this repo on the `feat/whatsub-license-aliyun-migration` branch; they were extracted to the standalone repo via `git subtree split` to keep concerns isolated). The marketing-landing-page half (sections 4 + 5) is still Plan B / not yet built.

---

## 1. Why this exists

Today the buyer flow is:

1. Buyer sees the product on the 小红书 store
2. Buys → 家兴 manually sends a zip + license code via DM

The current public download URLs (`jihulab.com/rjxznb-group/whatsub-release/...` and `github.com/rjxznb/whatsub-releases/...`) work but look like raw release pages, not a product. There is no "official-looking" link to share with buyers, no place to host activation help, no surface that establishes whatSub as a real product rather than a side hobby.

This site solves three problems at once:

- A **clean shareable URL** to put in 小红书 product descriptions (`whatsub.eversay.cc`)
- A **single source of truth** for download + activation help, so support DMs collapse to "see the website"
- An **on-ramp** for buyers who haven't bought yet — copy + screenshots that justify the price

It is **not** trying to drive new customer acquisition by itself (acquisition still happens on 小红书). It exists so the post-discovery experience feels like a product, not a side project.

---

## 2. Goals & non-goals

### Goals

- Single-page Chinese landing page that loads fast in mainland China
- Clean URL `whatsub.eversay.cc` that buyers can be sent without context
- Two prominent download buttons (Win + Mac) with version number visible
- "Buy" CTAs that route to the existing 小红书 store
- FAQ covering activation, device transfer, common Mac/Windows install issues
- Visual identity that matches the desktop app (black canvas + Caveat handwriting + `#3B9BFF` accent)

### Non-goals (will NOT do)

- English version — buyer base is Chinese-speaking; bilingual doubles copy work for ~0% gain. Code structure should stay translatable but no zh+en at launch
- Account / dashboard / login — the desktop app handles activation; the website never needs auth
- Direct payment / Stripe / WeChat Pay — buying happens on 小红书. Pricing card CTA is an external redirect
- Self-hosted analytics — Aliyun has no equivalent of CF's free analytics; if needed later, add a simple plausible.io / umami container, but launch without
- Blog / news / changelog — release notes already live on jihulab. If we want them surfaced, link out
- Testimonials, founder story — no real testimonials yet; founder section is overkill for a desktop tool
- Scenarios section — Eversay's 18-scene block doesn't apply to a general subtitle tool

---

## 3. Architecture

### 3.1 The host: existing Aliyun ECS

The website + license API both deploy to the **existing Aliyun ECS** that already serves Eversay (`47.93.87.206`, Ubuntu 22.04, Beijing region, ICP-filed). Reusing this server gives us:

- **Real mainland-China speed**: ~50-100ms response time vs Cloudflare's 5-10s first-handshake penalty under GFW throttling
- **Zero new infra**: existing nginx, Postgres, Let's Encrypt, Docker, deploy pipeline all reused
- **Zero new monthly cost**: the server is already paid for
- **One mental model**: same `docker save | scp` deploy flow Eversay already uses (whatsub gets its own `/opt/whatsub/docker-compose.yml` to keep blast radius isolated — see §3.2)

The trade-off accepted: **server is constrained** (1.6GB RAM, 2 cores). Adding a new heavy container would risk OOM. So the architecture is designed to add **at most 1 Node container** (~80-150MB RAM) and serve the website itself as static files directly out of nginx (no extra container).

### 3.2 Component breakdown

The whatsub services live in their **own Docker compose** at `/opt/whatsub/docker-compose.yml`, separate from the existing `/opt/enghub/docker-compose.yml`. They share infrastructure via the existing `enghub_default` Docker network and a shared host-side nginx config directory. **Each compose owns its own services and lifecycle** — `docker compose down` on one never touches the other.

```
┌─────────── /opt/enghub/docker-compose.yml ───────────┐
│   nginx (existing)                                    │
│   enghub-web (Next.js SSR, existing)                  │
│   enghub-api (NestJS, existing)                       │
│   postgres-15 (existing)                              │
│   networks: { default: { name: enghub_default } }    │
└──────────────────────────────────────────────────────┘
                        │
                        │ shared
                        │ enghub_default
                        │ network
                        │
┌─────────── /opt/whatsub/docker-compose.yml ──────────┐
│   whatsub-license (Hono on Node 20, NEW)              │
│   networks: { default: { name: enghub_default,        │
│                          external: true } }          │
└──────────────────────────────────────────────────────┘

         443/TLS
            │
       ┌────▼────┐                        ┌──────────────┐
       │  nginx  │ ───────────────────────│ /data/whatsub-web/ │
       │ (enghub)│   static fallback     │  HTML/JS/CSS    │
       └─┬─────┬─┘                        └──────────────┘
         │     │
   /api/license/*  /download/*  /admin/*   /
         │     │
         ▼     ▼
  ┌────────────────────┐
  │  whatsub-license   │
  │  :3002             │  (whatsub compose)
  └──────────┬─────────┘
             │
             ▼
  ┌────────────────────┐
  │  postgres-15       │  (enghub compose, shared)
  │  + new database    │
  │  `whatsub_license` │
  └────────────────────┘
```

**Shared host directories** (the connective tissue between the two composes):

| Path on host | Purpose | Owners |
|---|---|---|
| `/data/nginx-conf.d/` | Nginx server-block configs. enghub mounts `/data/nginx-conf.d/eversay.conf`, whatsub mounts `/data/nginx-conf.d/whatsub.conf`. nginx auto-loads everything in `conf.d/` | Both projects write here, nginx reads |
| `/data/whatsub-web/` | Compiled static site (`out/`) | whatsub deploy writes, enghub's nginx reads |
| Docker network `enghub_default` | Service-to-service hostnames | enghub creates (already exists); whatsub joins as `external: true` |
| Postgres `whatsub_license` database | License storage | enghub-postgres-1 hosts; whatsub-license container connects |

**What's new on the server (introduced by this project):**

- 1 new compose file at `/opt/whatsub/docker-compose.yml`
- 1 Docker container `whatsub-license` (Hono on Node 20-alpine, ~80MB image)
- 1 new file `/data/nginx-conf.d/whatsub.conf` — server block for `whatsub.eversay.cc`
- 1 new directory `/data/whatsub-web/` — static files
- 1 new Postgres database `whatsub_license` inside the existing `enghub-postgres-1` container
- 1 new SAN entry on the existing Let's Encrypt cert (`certbot --expand`)

**What's modified in enghub (one-time, then forgotten):**

- nginx volume mount in enghub's compose changes from whatever it currently is → `/data/nginx-conf.d:/etc/nginx/conf.d:ro` (so both projects can drop conf files in the shared dir). The existing eversay.conf gets moved into this directory as part of the migration. After this one-time change, enghub's compose stays untouched

**What's NOT touched:**

- Eversay services themselves (web, api, postgres containers untouched)
- Eversay's deploy procedure
- Eversay's TLS cert (just expanded with one extra SAN)
- nothing whatsub does ever requires `docker compose -f /opt/enghub/...` after the one-time setup

### 3.3 Tech stack

**Website (`client-website/`):**
- **Next.js 14 + App Router** — matches Eversay's stack, zero learning curve, can selectively reuse `useReveal` hook + CSS variable patterns
- **Tailwind CSS v3** — matches `client/` and Eversay
- **Static export** (`output: 'export'`) → pure HTML/CSS/JS in `out/`, served by nginx as static files
- No SSR runtime, no Next.js server, no Docker container for the website itself

**License backend (`whatsub-license/`):**
- **Hono** — lightweight web framework that runs on Node, Bun, or Cloudflare Workers. Choosing Node here for stable Docker compatibility. Hono's middleware/routing is similar to the Workers-flavored router that the old code used, so the rewrite is mostly mechanical
- **node-postgres (`pg`)** — direct Postgres client. The schema is small enough that an ORM would be overkill
- **Node 20 LTS Alpine** Docker base
- **Same admin SPA** (`public/admin/index.html`) — Alpine.js + Tailwind CDN, single page, no build step. Just point its base URL at the new endpoint

**Why Hono not the existing NestJS:** Eversay's API is NestJS, but adding routes to NestJS means modifying Eversay's deploy. Keeping whatsub-license as a separate service preserves blast-radius isolation — a bug in license code can't break Eversay. Hono is also tiny (~12KB) vs NestJS's ~10MB; on a 1.6GB-RAM server every megabyte counts.

### 3.4 Project layout

```
Get_Video/                                  # repo root
├── client/                                 # existing — Tauri desktop app
├── client-website/                         # NEW — marketing site, static export
│   ├── package.json                        # @whatsub/website (separate pnpm pkg)
│   ├── next.config.mjs                     # output: 'export'
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   ├── public/
│   │   ├── fonts/Caveat-{Bold,Medium}.woff2  # copied from client/public/fonts/
│   │   ├── og-image.png
│   │   ├── favicon.ico
│   │   └── screenshots/                    # 3 step GIFs + 4 feature stills
│   └── src/
│       ├── app/{layout,page,globals.css}
│       ├── components/{Nav,Hero,WhyCards,HowSteps,FeatureGrid,Download,Pricing,FAQ,FinalCTA,Footer}.tsx
│       ├── hooks/{useReveal,useLatestVersion}.ts
│       └── lib/constants.ts                # brand tokens as TS
├── whatsub-license/                        # NEW — replaces license-server/
│   ├── package.json                        # @whatsub/license, Hono + pg
│   ├── Dockerfile                          # multi-stage: pnpm install + build → distroless node:20-alpine
│   ├── docker-compose.yml                  # source-of-truth; deployed to /opt/whatsub/ on server
│   ├── nginx/whatsub.conf                  # source-of-truth nginx server block; deployed to /data/nginx-conf.d/
│   ├── tsconfig.json
│   ├── schema.sql                          # Postgres DDL (rewritten from D1 SQLite)
│   ├── src/
│   │   ├── index.ts                        # Hono app entry, listens :3002
│   │   ├── routes/
│   │   │   ├── activate.ts                 # POST /api/activate
│   │   │   ├── admin.ts                    # /api/admin/* (4 routes)
│   │   │   └── download.ts                 # /download/{win,mac} → 302 to jihulab
│   │   └── lib/
│   │       ├── auth.ts                     # Bearer token (constant-time compare)
│   │       ├── db.ts                       # pg pool + typed queries
│   │       └── keygen.ts                   # WHATSUB-XXXX generator (port from Workers code)
│   └── public/admin/index.html             # Alpine.js SPA (lifted verbatim from license-server/public/admin/)
├── license-server/                         # DELETE after migration is verified
├── scripts/                                # existing — Python data pipeline
└── docs/, data/, ...
```

### 3.5 What the user sees end-to-end

```
1. User opens https://whatsub.eversay.cc in a browser
2. nginx on Aliyun serves index.html from /data/whatsub-web/  (~50ms TTFB in mainland)
3. Page hydrates: Hero plays the "hey, whatSub?" Caveat-typing animation
4. useLatestVersion fetches /api/license/latest (same origin) → version chip + button URLs populate
5. User clicks "Windows 下载" → /download/win → nginx → whatsub-license:3002
   → fetch jihulab latest.json → 302 to actual .exe URL
   → browser downloads from jihulab (also fast in mainland)
```

License activation flow (in the desktop client):

```
1. User pastes WHATSUB-XXXX-XXXX-XXXX-XXXX in the activation gate
2. Client POSTs to https://whatsub.eversay.cc/api/license/activate
   { key, fingerprint, deviceLabel }
3. nginx → whatsub-license container → Postgres (whatsub_license DB)
4. ~100ms total round-trip in mainland (vs ~5-10s on the old CF Worker setup)
5. Response → client saves license.json → app enters ACTIVE
6. Forever offline after that
```

---

## 4. Brand system

The brand tokens are **copied verbatim from `client/src/components/WelcomeIntro.tsx`**. This is the source of truth — the website must not introduce new brand colors. If the desktop app changes its accent color, the website follows.

### 4.1 Color tokens

```css
:root {
  /* Surfaces (pure black canvas, never #111 or zinc-900) */
  --bg:           #000000;
  --bg-soft:      #0a0a0c;       /* alternate-row surface for section rhythm */
  --bg-elev:      #141418;       /* card / preview-window surface */

  /* Hairlines */
  --hairline:        rgba(255,255,255,0.08);
  --hairline-strong: rgba(255,255,255,0.14);

  /* Ink (text) — 4 tiers */
  --ink:        #ffffff;
  --ink-soft:   rgba(255,255,255,0.72);   /* body */
  --ink-muted:  rgba(255,255,255,0.48);   /* secondary / labels */
  --ink-faint:  rgba(255,255,255,0.30);   /* timestamps / mono captions */

  /* Brand accent — matches the "Sub" word in the desktop app's intro */
  --accent:        #3B9BFF;
  --accent-glow:   rgba(59, 155, 255, 0.35);

  /* Highlight (matches client SubtitleList yellow underline) */
  --amber:        #FCD34D;
  --amber-soft:   rgba(252, 211, 77, 0.18);

  /* Status (matches client BackendDetected dot) */
  --status-ok:    #4ade80;
}

/* Page background uses radial vignette identical to WelcomeIntro */
body {
  background: #000;
  background-image: radial-gradient(ellipse at center, rgba(40,40,50,0.35) 0%, rgba(0,0,0,1) 70%);
}
```

**Critical constraints:**

- Canvas must be `#000`. Not `#0a0a0c`, not zinc-950, not slate-950 — pure black, exactly matching the desktop app
- Accent `#3B9BFF` is used **only** for: the "Sub" wordmark, the primary "购买授权" button, hover/focus states, and a single accent word per section. Reserving it preserves brand recognition
- Amber `#FCD34D` is used **only** for English highlight words inside subtitle previews — never on UI chrome
- No gradients beyond the radial vignette and the optional Sub text-shadow glow

### 4.2 Typography

**Self-host Caveat** by copying `Caveat-Bold.woff2` + `Caveat-Medium.woff2` from `client/public/fonts/` into the website's `public/fonts/`. Same `@font-face` declaration as `client/src/App.css`. This keeps the wordmark byte-identical to the desktop app and avoids a Google Fonts dependency (Google Fonts is occasionally throttled in mainland China).

Sans body uses **Inter** loaded from `@fontsource/inter` (or the Google Fonts CDN with `<link rel="preload">`). Mono uses **JetBrains Mono** for technical labels (timestamps, version strings, status badges).

| Role | Font | Size | Weight | Tracking | Where |
|------|------|------|--------|----------|-------|
| Brand wordmark | Caveat | 32px (nav) / 130px (hero signature) | 700 | -0.01em | Nav brand, Hero signature |
| Section title | Caveat | 56–80px responsive | 700 | -0.01em | Each section heading |
| Body H3 | Inter | 22px | 600 | 0 | Card titles |
| Body | Inter | 17px / 15px | 400 | 0 | Tagline, body copy |
| Caption / timestamp / version | JetBrains Mono | 12px | 400/500 | 0.04em | Eyebrow chip, mono labels |

The signature `hey, whatSub?` is the whole brand visual. Nothing else on the page uses cursive — section titles repeat Caveat at smaller scale to tie the rhythm together, but body copy, buttons, and labels are sans/mono. The contrast between the playful Caveat headline and the precise sans body is the design's core tension.

### 4.3 Surface rhythm

Sections alternate between three surfaces:

1. `--bg` (pure black, with vignette) — Hero, alternating sections
2. `--bg-soft` (#0a0a0c) — adjacent sections; barely-visible difference but breaks visual fatigue on a long page
3. `--bg-elev` (#141418) — cards inside a section, preview windows

Order down the page: Hero (bg) → Why (bg-soft) → How (bg) → Features (bg-soft) → Download (bg) → Pricing (bg-soft) → FAQ (bg) → Final CTA (bg-soft, with accent glow) → Footer (bg). Never two of the same surface in a row.

### 4.4 Spacing + layout

- Max content width: **1200px**, centered
- Section vertical padding: **96px top + 96px bottom** (matches Eversay's `--section-gap-marketing`)
- Horizontal page padding: **24px mobile, 40px tablet, 64px desktop**
- Card grid: 4-up desktop / 2-up tablet / 1-up mobile (Why + Features); 3-up desktop / 1-up mobile (How + Pricing if multi); single-column FAQ
- Border radius: 8px buttons, 12px cards, 14px the hero preview window
- Hairline borders only — no drop shadows except on the hero preview window (one large blue-tinted shadow to imply depth)

---

## 5. Page structure (9 sections)

Each section below specifies: purpose, content, visual treatment, components used.

### 5.1 Nav

- **Purpose**: Brand recognition + scroll-to anchors + visible CTA
- **Layout**: Fixed top bar, 64px height, `--bg/0.85` + `backdrop-filter: blur(8px)` so it floats over the hero. Border-bottom appears on scroll
- **Content**:
  - Left: `whatSub?` wordmark (Caveat 32px, "Sub" in `--accent`, "?" in `--ink`)
  - Right: 功能 / 下载 / 定价 / FAQ as ghost links → smooth-scroll anchors. Then a primary "购买授权" button (Sub-blue, 9×18 padding, 8px radius, soft glow)
- **Behavior**: `useScrolled` hook adds the bottom hairline once `scrollY > 8`

### 5.2 Hero

- **Purpose**: Brand statement + primary download CTAs
- **Visual**: Centered. Vignette background. Subtle `radial-gradient` dotted grid as 4%-opacity texture (gives "tool" feel)
- **Content**:
  - Eyebrow chip: mono caption `v0.1.25 · macOS Apple Silicon & Windows 10/11` with a green status dot
  - Signature (Caveat 130px responsive 88px on mobile): `hey, whatSub?` — `Sub` in accent with text-shadow glow
  - Tagline (Inter 22px): `让一句字幕，慢慢成为你的英语。` (locked from brainstorm)
  - Two buttons: Primary `⬇ Windows 下载` (white bg, black text, 48px height) + Secondary `⬇ macOS 下载` (transparent bg, hairline border)
  - Mono meta line: `v0.1.25 · 100% 本地运行 · 不上传任何视频`
  - Below CTAs: a fake app preview window with bilingual subtitle rows (left video pane, right caption pane with active row highlighted in accent + amber highlight on key phrases). Single large blue-tinted shadow for depth
- **Components**: `<Hero>` self-contained; reads version + download URLs from `useLatestVersion()` hook

### 5.3 Why whatSub (4 reason cards)

- **Purpose**: Justify the price. Each card is a defensible point about how this is different from "just adding subtitles"
- **Layout**: 4-up grid on desktop, with 16px gaps. Cards on `--bg-elev` with hairline border
- **Cards**:
  1. **本地转录** — Whisper 模型在本机 GPU 跑，视频和音频从不离开你的电脑。Win Vulkan / Mac Metal 双平台加速
  2. **任意 LLM** — DeepSeek / OpenAI / Claude / Kimi / Gemini 自己的 API key。10 个预设 + 自定义。换厂商不绑死
  3. **真正的双语字幕** — 不只是机翻挂底下。重点短语黄底高亮、IPA 发音、TTS 朗读，跟着字幕同步滚动
  4. **词汇本沉淀** — 看到一个生词 ⭐ 一下，跨视频汇总。CSV 导出，一键跳回原片对应字幕段
- **Each card**: small icon (lucide), Caveat-handle title (28px), Inter description (14px, `--ink-soft`)
- **Section title**: Caveat 64px `为什么不只是「加个字幕」？` ("不只是「加个字幕」" with subtle accent underline)

### 5.4 How it works (3 alternating steps)

- **Purpose**: Show real product flow + actual UI screenshots so buyers know what they're getting
- **Layout**: 3 rows, alternating left-right (text on left → GIF on right → text on right → GIF on left). Same `STEP_MEDIA` pattern as Eversay
- **Steps**:
  1. **导入** — 粘 YouTube 链接 / 拖本地 mp4 → yt-dlp + ffmpeg 自动跑。GIF: ImportModal phase progression
  2. **本地识别** — Whisper 模型在你的 GPU 上跑，进度实时可见。GIF: Transcribing phase + BackendDetected
  3. **双语播放** — 字幕、词汇、播放器、词汇本一体化的 Player 页。GIF: Player with bilingual subtitles + keyphrase panel + StarButton click
- **Section title**: Caveat 64px `三步，从一段视频走到一份词汇。`
- **GIF dimensions**: 1280×800 native, displayed at 12-col grid 6-col wide

### 5.5 Features (4 hover-image cards)

- **Purpose**: Show the "delight" features that aren't core but add up — what makes whatSub feel polished
- **Layout**: 4-up grid, hover-image-overlay pattern (same as Eversay's `beyond-card`). Default: text-only card. Hover: full-bleed screenshot fills the card
- **Cards**:
  1. **词汇本** — 跨视频汇总、CSV 导出、深链跳回。Hover: Vocab page screenshot
  2. **字幕导出** — 英文 / 中文 / 双语 SRT，或烧录进 mp4 三档画质。Hover: ExportVideoModal screenshot
  3. **字幕编辑** — 行内文本/时间戳直接改、拖拽重排、加行删行。Hover: SubtitleList edit-mode screenshot
  4. **黄底高亮 + IPA** — 重点短语黄底标线、IPA 音标、TTS 一键朗读。Hover: SubtitleList with HighlightWord tooltip + KeyPhrase card
- **Section title**: Caveat 64px `比 「字幕翻译工具」 多走了几步路。`

### 5.6 Download (the section that actually closes)

- **Purpose**: This is what 90% of arrivals scroll to. Make it impossible to miss
- **Layout**: Full-width `--bg`. Centered card with two large platform tiles
- **Content**:
  - Section title: Caveat 64px `下载 whatSub`
  - Mono subtitle: `当前最新版本 v{X.Y.Z} · 发布于 {YYYY-MM-DD}` — both fields populated client-side from `/api/latest` (the website never hard-codes the date)
  - Two tiles side-by-side:
    - **Windows 10/11 x64** — big NSIS exe button + size + secondary "GitHub 备用下载" link
    - **macOS Apple Silicon** — big DMG button + size + secondary "GitHub 备用下载" link
  - Below tiles: `Intel Mac 暂不支持 · ARM64 Windows 暂不支持` muted note
- **Behavior**: All download buttons go to `/download/{win,mac}` (relative URL). No external link visible until click

### 5.7 Pricing (single tier)

- **Purpose**: Surface price + route to 小红书
- **Layout**: Single centered card on `--bg-soft`. Card on `--bg-elev` with hairline border, slight glow
- **Content**:
  - 小标题 mono: `授权方式`
  - Big price: `¥ XX` (家兴 to fill in actual price)
  - 子标题: `永久授权 · 一份授权码 · 3 台个人设备`
  - Feature checklist:
    - ✓ 永久使用，不订阅
    - ✓ 一份授权码可在 3 台设备同时激活
    - ✓ 换设备联系客服免费释放槽位
    - ✓ 所有未来更新免费
    - ✓ 不限制视频数量、不限制使用时长
  - CTA button: 「在小红书购买」(opens external link in new tab)
- **Section title**: Caveat 64px `一份授权，3 台设备。`

### 5.8 FAQ

- **Purpose**: Reduce DM volume. Cover the 5–7 questions that actually arrive
- **Layout**: Single column, expandable rows (same chevron-rotate pattern as Eversay's scenarios)
- **Items**:
  1. **激活授权码后多久能用？** — 立即可用。在线验证 1 次后软件完全离线运行
  2. **国内能不能正常激活？** — 可以。激活服务器在国内（阿里云北京节点，eversay.cc 已备案），通常 200ms 内完成激活。激活成功后软件完全离线运行，永不再联网
  3. **3 台设备用满了怎么办？** — 联系客服私信，释放任意一台的槽位（免费、不限次数）
  4. **macOS 双击提示「已损坏」怎么办？** — 把 .app 拖进 Applications 文件夹再打开（直接从下载目录打开会触发 Gatekeeper App Translocation）
  5. **为什么需要 LLM API key？** — 翻译是用你自己的 LLM 账号调，按 token 付费。DeepSeek 最便宜（约 ¥0.001/千 tokens），整片视频通常几分钱
  6. **视频会不会上传？** — 不会。Whisper 转录在你的 GPU 上跑，LLM 翻译只发字幕文本（不发音视频）。隐私敏感的可以全关云端、用 Ollama 本地 LLM
  7. **能不能退款？** — 不支持。数字商品售出不退（购买前请用 1.0 体验版试用）
- **Section title**: Caveat 64px `常见问题。`

### 5.9 Final CTA

- **Purpose**: Last conversion surface for users who scrolled to the bottom
- **Layout**: Full-bleed band, `--bg-soft` with strong vignette + extra accent-blue glow. Centered text + single CTA
- **Content**:
  - Caveat 80px: `开始 看 字幕 。`
  - Inter 18px: `下载 whatSub，把下一段看不懂的视频，变成下一句你会说的英语。`
  - Single button: `⬇ 立即下载` (smooth-scroll back up to Download section)

### 5.10 Footer

- **Purpose**: Legal + boring stuff
- **Layout**: 64px padding, single row on desktop, stacked on mobile
- **Content**:
  - Left: `© 2026 whatSub` + ICP 备案号 (eversay.cc 现有备案号 京ICP备2026014893号-1)
  - Right: 联系客服 (小红书 link) · 隐私 · 条款
- **Visual**: Pure `--bg`, 12px mono, `--ink-faint` text

---

## 6. Functional behaviors

### 6.1 nginx server block

A new file `/data/nginx-conf.d/whatsub.conf` in the **shared nginx config directory** (mounted into the existing enghub nginx container at `/etc/nginx/conf.d/whatsub.conf`). The existing `eversay.conf` server block in the same directory stays untouched. nginx auto-loads every `*.conf` in `conf.d/` so both products co-exist without either's compose having to reference the other's files.

```nginx
server {
    listen 443 ssl http2;
    server_name whatsub.eversay.cc;

    ssl_certificate     /etc/letsencrypt/live/eversay.cc/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/eversay.cc/privkey.pem;
    # Cert covers eversay.cc + www.eversay.cc + whatsub.eversay.cc after `certbot --expand`

    # License API + version proxy → Hono container
    location /api/license/ {
        proxy_pass         http://whatsub-license:3002/api/;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }

    # Download redirects → same container, separate path
    location /download/ {
        proxy_pass         http://whatsub-license:3002/download/;
        proxy_set_header   Host              $host;
    }

    # Admin SPA → same container
    location /admin/ {
        proxy_pass         http://whatsub-license:3002/admin/;
        proxy_set_header   Host              $host;
    }

    # Static marketing site — nginx serves files directly, no proxy
    root /data/whatsub-web;
    index index.html;

    location / {
        try_files $uri $uri.html $uri/index.html /index.html;
    }

    # Cache Next.js fingerprinted assets aggressively
    location /_next/static/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    gzip on;
    gzip_types text/css text/javascript application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}

# HTTP → HTTPS
server {
    listen 80;
    server_name whatsub.eversay.cc;
    return 301 https://$host$request_uri;
}
```

### 6.2 Download endpoints (in whatsub-license container)

Implemented as Hono routes inside the same Node container that handles license activation. Cleaner than a separate service for redirects — the same code can serve `/download/{win,mac}` (302) and `/api/license/latest` (JSON for the version chip).

```ts
// whatsub-license/src/routes/download.ts
import { Hono } from 'hono';

const LATEST_JSON_URL =
    'https://jihulab.com/rjxznb-group/whatsub-release/-/releases/permalink/latest/downloads/latest.json';
const GITHUB_FALLBACK_BASE =
    'https://github.com/rjxznb/whatsub-releases/releases/latest/download';

// In-process cache, refreshed every 60s. Single Docker container, no
// horizontal scaling, so a Map is enough — no Redis needed.
let cached: { data: any; expiresAt: number } | null = null;

async function fetchLatest() {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.data;
    const res = await fetch(LATEST_JSON_URL, {
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`latest.json fetch failed: ${res.status}`);
    const data = await res.json();
    cached = { data, expiresAt: now + 60_000 };
    return data;
}

export const downloadRoutes = new Hono()
    .get('/win', async (c) => {
        try {
            const latest = await fetchLatest();
            return c.redirect(latest.platforms['windows-x86_64'].url, 302);
        } catch {
            return c.redirect(`${GITHUB_FALLBACK_BASE}/whatsub_x64-setup.exe`, 302);
        }
    })
    .get('/mac', async (c) => {
        try {
            const latest = await fetchLatest();
            return c.redirect(latest.platforms['darwin-aarch64'].url, 302);
        } catch {
            return c.redirect(`${GITHUB_FALLBACK_BASE}/whatsub_aarch64.dmg`, 302);
        }
    });

// /api/license/latest — wraps latest.json for the website's useLatestVersion hook
export const latestJsonRoute = new Hono().get('/latest', async (c) => {
    try {
        const latest = await fetchLatest();
        return c.json({
            version: latest.version,
            pubDate: latest.pub_date,
            winUrl: latest.platforms['windows-x86_64']?.url,
            macUrl: latest.platforms['darwin-aarch64']?.url,
        });
    } catch {
        return c.json({ version: null, error: 'upstream_unavailable' }, 503);
    }
});
```

**Why fetch latest.json each request rather than hard-coding URLs:** the desktop app's `latest.json` already exists for the in-app updater. Reusing it means the website auto-tracks new releases — the day a new version ships, `/download/win` points at the new exe with zero website redeploy. The 60s in-process cache caps upstream traffic; from Aliyun in 北京 to jihulab.com (also mainland-hosted), the fetch is sub-50ms, well within the 5s `AbortSignal.timeout`.

### 6.3 Version display on the page

```ts
// client-website/src/hooks/useLatestVersion.ts
export function useLatestVersion() {
    const [data, setData] = useState<LatestInfo | null>(null);
    useEffect(() => {
        fetch('/api/license/latest')
            .then((r) => r.json())
            .then(setData)
            .catch(() => {
                // Graceful fallback — page never breaks even if API is down
                setData({ version: '0.1.25', pubDate: null, winUrl: null, macUrl: null });
            });
    }, []);
    return data;
}
```

The Hero eyebrow and Download section's version chip update once this resolves. Fallback to hardcoded `v0.1.25` if the fetch fails. Hard-coded value gets bumped manually each release; cheap insurance.

### 6.4 Smooth-scroll anchors

`document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })` — copy the same `scrollToSection` callback Eversay's nav uses. No router/route hash games — single page, plain anchor scrolling.

### 6.5 SEO + meta

- `<html lang="zh">` (not `lang="zh-CN"` — broader)
- Title: `whatSub — 让一句字幕，慢慢成为你的英语`
- Description: ≤155 chars, mentions YouTube + 双语字幕 + 词汇本 + 本地转录
- OpenGraph image at `/og-image.png` — hero signature on black, 1200×630
- `robots.txt` allow all + sitemap.xml (single URL, but standard practice)
- `manifest.json` for the favicon set

---

## 7. License-server migration (CF Workers + D1 → Node + Postgres)

The existing `license-server/` is Cloudflare Workers + D1 SQLite. Migrating to a Node + Postgres container in the existing Aliyun stack. Because the product hasn't been sold yet (zero production data), this is a **clean cut** — no data export, no compatibility shims, no sunset window for old clients.

### 7.1 What changes

| Layer | Old (CF Workers + D1) | New (Node + Postgres on Aliyun) |
|---|---|---|
| Runtime | Cloudflare Workers (V8 isolates) | Node 20 LTS in Docker |
| Web framework | Workers fetch handler + ad-hoc router | Hono |
| Database | D1 SQLite (CF-managed) | Existing Postgres, new database `whatsub_license` |
| Schema dialect | SQLite | Postgres (BIGSERIAL, BIGINT for ms timestamps) |
| Deployment | `wrangler deploy` | `docker save` → `scp` → `docker compose up -d` (matches Eversay flow) |
| Activation endpoint | `https://whatsub-license.<sub>.workers.dev/api/activate` | `https://whatsub.eversay.cc/api/license/activate` |
| Admin URL | `https://whatsub-license.<sub>.workers.dev/admin/` | `https://whatsub.eversay.cc/admin/` |
| Secret storage | `wrangler secret put ADMIN_TOKEN` | Server `/opt/enghub/.env` (existing pattern) |

### 7.2 Schema port (SQLite → Postgres)

Same 2 tables conceptually; only dialect changes:

```sql
-- whatsub-license/schema.sql

CREATE TABLE IF NOT EXISTS licenses (
    key          TEXT     PRIMARY KEY,
    max_devices  INTEGER  NOT NULL DEFAULT 3,
    created_at   BIGINT   NOT NULL,    -- unix ms (BIGINT to match Workers code)
    buyer_note   TEXT,
    email        TEXT
);

CREATE TABLE IF NOT EXISTS activations (
    id              BIGSERIAL  PRIMARY KEY,
    license_key     TEXT       NOT NULL REFERENCES licenses(key),
    fingerprint     TEXT       NOT NULL,
    device_label    TEXT,
    activated_at    BIGINT     NOT NULL,
    last_seen_at    BIGINT     NOT NULL,
    deactivated_at  BIGINT,
    UNIQUE (license_key, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_act_key      ON activations (license_key);
CREATE INDEX IF NOT EXISTS idx_act_active   ON activations (license_key, deactivated_at);
CREATE INDEX IF NOT EXISTS idx_lic_created  ON licenses    (created_at DESC);
```

Differences from the D1 schema:

- `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`
- All `?` parameter placeholders in queries become `$1, $2, ...` (Postgres positional)
- `INSERT OR REPLACE` (SQLite) becomes `INSERT ... ON CONFLICT (...) DO UPDATE SET ...`
- Foreign key constraint enforced by default (no PRAGMA needed)

### 7.3 Code port

The Workers code maps cleanly:

| Old file | New file | Change |
|---|---|---|
| `license-server/src/index.ts` | `whatsub-license/src/index.ts` | Hono app instead of fetch handler |
| `license-server/src/routes/activate.ts` | `whatsub-license/src/routes/activate.ts` | `c.json(x)` instead of `new Response(JSON.stringify(x))` |
| `license-server/src/routes/admin.ts` | `whatsub-license/src/routes/admin.ts` | Same translation, plus `serveStatic` for `/admin/` |
| `license-server/src/lib/auth.ts` | `whatsub-license/src/lib/auth.ts` | Verbatim — constant-time compare unchanged |
| `license-server/src/lib/db.ts` | `whatsub-license/src/lib/db.ts` | D1 `.prepare().bind().run()` → `pg.query('... $1, $2', [a, b])` |
| `license-server/src/lib/keygen.ts` | `whatsub-license/src/lib/keygen.ts` | Verbatim, just `node:crypto` instead of Workers `crypto` |
| `license-server/public/admin/index.html` | `whatsub-license/public/admin/index.html` | Verbatim, plus update fetch base URL from `''` to `/api/license` |

Estimated touched lines: ~200, mostly mechanical syntax updates. Logic unchanged.

### 7.4 Postgres database isolation

Add a **second database** to the existing `enghub-postgres-1` container (not a new container, not a schema in the existing DB):

```sql
-- One-time setup, run as postgres superuser inside the existing container
CREATE DATABASE whatsub_license;
CREATE USER whatsub_license_user WITH PASSWORD 'XXX';   -- generate strong, store in .env
GRANT ALL PRIVILEGES ON DATABASE whatsub_license TO whatsub_license_user;
```

Then `schema.sql` is applied to that database. The whatsub-license container connects via:

```
DATABASE_URL=postgres://whatsub_license_user:XXX@postgres:5432/whatsub_license
```

This isolates:

- **Schema**: no chance of `licenses` table colliding with anything in Eversay
- **Credentials**: whatsub creds can't read Eversay data and vice versa
- **Backup/restore**: each DB can be `pg_dump`'d independently

### 7.5 Cutover plan

1. Build whatsub-license container locally → `docker save` → `scp` to server
2. Apply `schema.sql` to the new `whatsub_license` database
3. Add nginx conf, expand Let's Encrypt cert, restart nginx (verify HTTPS on `whatsub.eversay.cc`)
4. Issue 1-2 test keys via `/admin/`, verify activation flow end-to-end from a dev whatSub client pointed at the new endpoint
5. Update the Tauri client's `ACTIVATE_ENDPOINT` constant (see section 8) and ship a new release
6. Delete `license-server/` repo directory and shut down the CF Worker (no users to migrate — confirmed)

---

## 8. Client-side endpoint switch

The Tauri client at `client/src/types/license.ts` has the activate endpoint hardcoded as a constant. The website spec requires changing it to the new URL.

```ts
// BEFORE (client/src/types/license.ts)
export const ACTIVATE_ENDPOINT =
    'https://whatsub-license.<old-subdomain>.workers.dev/api/activate';

// AFTER
export const ACTIVATE_ENDPOINT =
    'https://whatsub.eversay.cc/api/license/activate';
```

This is a one-line change but requires a new client release (the endpoint is baked into the binary at compile time).

**Coordinated release plan:**

1. Cut new whatSub client version `v0.2.0` with the URL update
2. Build + sign + publish via the existing GitHub Actions release workflow
3. New version goes live on jihulab + GitHub mirrors via the standard release pipeline
4. Old version users — none yet, since the product isn't live (confirmed in conversation)
5. After the new client is live, the website's "Windows 下载" / "macOS 下载" buttons point at v0.2.0+ via the `latest.json` mechanism, so any new buyer gets the right binary automatically
6. CF Worker can be deleted after the new client is verified working — no rollback needed, no users to migrate

---

## 9. Build + deploy (Aliyun + Docker)

This section follows the same `docker save → scp → docker load → up -d` pattern documented in `Enghub/docs/server-operations.md`. The 1.6GB-RAM server cannot build images; everything builds locally and ships as image tarballs.

### 9.1 Local dev

```bash
# Marketing site
cd client-website
pnpm install
pnpm dev               # http://localhost:3000
pnpm build             # → out/ (static export)
pnpm typecheck

# License API
cd whatsub-license
pnpm install
pnpm dev               # http://localhost:3002, hot-reloads on src/ change
pnpm typecheck
docker build -t whatsub-license:latest .
```

### 9.2 The whatsub docker-compose.yml

Lives at **`/opt/whatsub/docker-compose.yml`** on the server. Joins enghub's existing network as `external`. enghub's compose stays untouched (after the one-time nginx-mount migration in §9.4).

```yaml
# /opt/whatsub/docker-compose.yml
services:
  whatsub-license:
    image: whatsub-license:latest
    container_name: whatsub-license
    restart: unless-stopped
    environment:
      DATABASE_URL: ${WHATSUB_LICENSE_DATABASE_URL}
      ADMIN_TOKEN:  ${WHATSUB_LICENSE_ADMIN_TOKEN}
      PORT: 3002
      NODE_ENV: production
    networks:
      - default
    # No port mapping — nginx talks to it via the docker network on :3002
    # No depends_on for postgres — it's in another compose; we rely on
    # the connection retry loop in src/lib/db.ts (5 attempts, 2s backoff)
    # for the brief window during boot when postgres isn't yet ready.

networks:
  default:
    name: enghub_default
    external: true   # the network is created by enghub's compose
```

The whatsub side does **not** define a postgres service or an nginx service — both are reused from enghub's compose via the shared network. This is the entire whatsub-side YAML; nothing else.

### 9.3 Deploy procedure (per release)

**Locally:**

```bash
# 1. Build the static site (only when website changes)
cd client-website
pnpm build
tar czf /tmp/whatsub-web.tar.gz -C out .

# 2. Build the license container (only when API changes)
cd ../whatsub-license
docker build -t whatsub-license:latest .
docker save whatsub-license:latest | gzip > /tmp/whatsub-license.tar.gz

# 3. scp the artifact(s) you actually changed
scp -i ~/.ssh/id_ed25519 \
    /tmp/whatsub-web.tar.gz \
    /tmp/whatsub-license.tar.gz \
    root@47.93.87.206:/tmp/

# 4. Apply on the server
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206 << 'EOF'
    # Static site: extract into nginx-mounted volume (atomic via temp dir + rename)
    if [ -f /tmp/whatsub-web.tar.gz ]; then
        rm -rf /data/whatsub-web.new
        mkdir -p /data/whatsub-web.new
        tar xzf /tmp/whatsub-web.tar.gz -C /data/whatsub-web.new
        rm -rf /data/whatsub-web.old
        [ -d /data/whatsub-web ] && mv /data/whatsub-web /data/whatsub-web.old
        mv /data/whatsub-web.new /data/whatsub-web
        rm /tmp/whatsub-web.tar.gz
    fi

    # License container: load image + recreate (whatsub compose only)
    if [ -f /tmp/whatsub-license.tar.gz ]; then
        docker load < /tmp/whatsub-license.tar.gz
        cd /opt/whatsub
        docker compose up -d --force-recreate whatsub-license
        rm /tmp/whatsub-license.tar.gz
    fi

    # Cleanup old static dir only after verification
    rm -rf /data/whatsub-web.old
EOF
```

**Most releases touch only one of the two artifacts.** Copy edits to the marketing site re-deploy just `whatsub-web.tar.gz` (no Docker action). API logic changes re-deploy just the license container (no static-site action). The deploy script's `if [ -f ... ]` guards skip whichever artifact wasn't built.

**Critically: the deploy never touches `/opt/enghub/`** — only `/opt/whatsub/` and the shared `/data/` directories. enghub's services are unaffected by whatsub releases.

### 9.4 First-time server setup (one-off)

This is the only step that touches enghub's setup, and it's a small modification — switching enghub's nginx to load configs from a shared host directory instead of its current location. After this, the two products operate independently.

```bash
ssh -i ~/.ssh/id_ed25519 root@47.93.87.206

# === Step 1: Migrate nginx conf to shared dir (one-time, touches enghub) ===

# Create the shared nginx config dir
mkdir -p /data/nginx-conf.d

# Move enghub's existing nginx config to the shared dir
# (location depends on current setup; check `docker compose -f /opt/enghub/docker-compose.yml config`
#  for the current nginx volume to find the source)
cp /opt/enghub/nginx/conf.d/eversay.conf /data/nginx-conf.d/eversay.conf

# Edit /opt/enghub/docker-compose.yml's nginx service:
# Change the conf.d volume mount FROM whatever it currently is TO:
#   - /data/nginx-conf.d:/etc/nginx/conf.d:ro
# (keep all other nginx volumes — TLS certs, html roots, etc — untouched)

# Restart enghub's nginx to pick up the new mount
cd /opt/enghub
docker compose up -d --force-recreate nginx

# Verify enghub still works: curl -I https://eversay.cc — should return 200

# === Step 2: Expand Let's Encrypt cert to cover whatsub subdomain ===

certbot --expand -d eversay.cc -d www.eversay.cc -d whatsub.eversay.cc

# === Step 3: Create whatsub server block + static dir ===

mkdir -p /data/whatsub-web                       # static files target
cat > /data/nginx-conf.d/whatsub.conf <<'CONF'
# ... contents from section 6.1 ...
CONF

# === Step 4: Whatsub Postgres database + user ===

docker compose -f /opt/enghub/docker-compose.yml exec postgres psql -U postgres <<'SQL'
    CREATE DATABASE whatsub_license;
    CREATE USER whatsub_license_user WITH PASSWORD 'XXX';
    GRANT ALL PRIVILEGES ON DATABASE whatsub_license TO whatsub_license_user;
SQL

# === Step 5: Whatsub compose dir + env file ===

mkdir -p /opt/whatsub
cat > /opt/whatsub/.env <<'ENV'
WHATSUB_LICENSE_DATABASE_URL=postgres://whatsub_license_user:XXX@postgres:5432/whatsub_license
WHATSUB_LICENSE_ADMIN_TOKEN=<generate strong random hex>
ENV
chmod 600 /opt/whatsub/.env

# Drop the docker-compose.yml from §9.2 into /opt/whatsub/

# === Step 6: First deploy ===

# (back on local machine, run the §9.3 deploy script)

# === Step 7: Apply schema ===

docker compose -f /opt/enghub/docker-compose.yml exec -T postgres \
    psql -U whatsub_license_user -d whatsub_license < whatsub-license/schema.sql

# === Step 8: Restart enghub's nginx to pick up the new whatsub.conf ===

docker compose -f /opt/enghub/docker-compose.yml exec nginx nginx -s reload
# (or: docker compose -f /opt/enghub/docker-compose.yml restart nginx)
```

After step 8: `https://whatsub.eversay.cc` is live. From now on, every whatsub release uses §9.3's deploy script and never touches enghub's compose or directories — only the whatsub compose, the shared `/data/whatsub-web/`, and the shared `/data/nginx-conf.d/whatsub.conf`.

### 9.5 Memory budget check

Existing containers' steady-state RSS (from `docker stats` on Eversay's server):

| Container | RSS | Notes |
|---|---|---|
| nginx | ~25 MB | Fixed |
| enghub-web (Next.js SSR) | ~250 MB | Largest |
| enghub-api (NestJS) | ~150 MB | |
| postgres | ~80 MB | Plus shared_buffers |
| OS / kernel / cron | ~150 MB | |
| **Subtotal** | **~655 MB** | |

Adding **whatsub-license** (Node 20 + Hono):

| New | Estimate |
|---|---|
| whatsub-license | ~80 MB |
| **New total** | **~735 MB** |

Headroom on a 1.6GB system: **~865 MB free + 1GB swap**. Comfortable. The static site adds **0 MB** (served by existing nginx, no new process).

If memory ever becomes tight, options listed in 9.6.

### 9.6 If the server runs out of memory

- whatsub-license container can drop to `node:20-alpine-slim` (~50 MB → 35 MB)
- Move `whatsub-license` to **Bun** runtime (~25 MB) — Hono runs natively on Bun, code unchanged
- Last resort: scale up to 阿里云 ECS 4 GB instance (~30 元/月 extra)

---

## 10. Out of scope (don't build these now)

- English version (preserve i18n hooks placement, but ship zh-only)
- Account / login
- Direct payment
- Blog / changelog
- Theme switcher (the brand is dark; no light mode)
- Real testimonials (none yet)
- Analytics dashboard (CF analytics built-in is enough)
- Newsletter signup
- Live chat widget (link to 小红书 is enough)

---

## 11. Open questions

None remaining at spec time — all visual + structural + functional decisions are locked. Implementation specifics (exact pricing number, screenshot capture details, GIF recording, the strong random `WHATSUB_LICENSE_DATABASE_URL` password + admin token) are tasks for the implementation plan, not architectural decisions.

---

## 12. Success criteria

- Site loads to interactive in **<1s** on mainland 4G without VPN (was <2s in the CF version — Aliyun should be much faster)
- Download buttons work end-to-end (302 → jihulab download starts) on both Win and Mac
- License activation round-trip **<200ms** in mainland (was 5-10s on CF Worker — this is the headline win)
- Buy CTA opens 小红书 store (mobile + desktop)
- All 9 page sections render correctly at 360px / 768px / 1024px / 1440px / 1920px viewport widths
- Hero animation runs at 60fps on 2-year-old laptops
- Version number on the page matches the latest GitHub/jihulab release within 60s of a new release publishing
- whatsub-license container memory steady-state stays under 150 MB on the Aliyun ECS
- 家兴 stops sending zip files in 小红书 DMs within 1 month of launch (the real product KPI)
