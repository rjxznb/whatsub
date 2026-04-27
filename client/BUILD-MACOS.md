# Building on macOS — From Zero

A complete step-by-step for building the Get Video desktop app on a fresh
macOS machine with **nothing pre-installed**. After following this once, you
should be able to:

- Run a development build (`pnpm tauri dev`)
- Produce a distributable installer (`.dmg` / `.app`)

The whole setup takes ~30 min on a decent connection. Most of the time is
download (Xcode CLT, Rust toolchain, Node, brew packages).

> **Architectures**: Apple Silicon (M1 / M2 / M3 / M4) → target triple is
> `aarch64-apple-darwin`. Intel Mac → `x86_64-apple-darwin`. The instructions
> below assume Apple Silicon; for Intel, swap `aarch64` → `x86_64` everywhere
> the triple appears.

---

## 1. One-time toolchain setup

### 1.1 Xcode Command Line Tools

Required by basically every compiler on Mac. Run in Terminal:

```bash
xcode-select --install
```

A GUI prompt will pop up. Accept and wait ~5–10 min. Verify:

```bash
xcode-select -p   # should print /Library/Developer/CommandLineTools
clang --version   # should print Apple clang version ...
```

### 1.2 Homebrew (package manager)

Lets you install ffmpeg, yt-dlp, etc. without compiling them yourself.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the on-screen instructions. **At the end it will ask you to add brew
to your PATH** with two `eval` commands — copy-paste those into your
terminal AND into `~/.zprofile` (Apple Silicon) or `~/.bash_profile` (Intel),
so future shells find `brew` automatically.

Verify:

```bash
brew --version
```

### 1.3 Rust toolchain (rustup)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Choose **option 1 (default install)**. After it finishes, **open a new
terminal tab** so PATH refreshes (or `source $HOME/.cargo/env`). Verify:

```bash
cargo --version    # 1.7x or newer
rustc --version
```

### 1.4 Node.js + pnpm

Use Node 20+ for Vite 7 compatibility.

```bash
brew install node
npm install -g pnpm
```

Verify:

```bash
node --version    # v20.x or newer
pnpm --version    # 10.x or newer
```

### 1.5 Git

Usually comes with Xcode CLT (1.1 above). Check:

```bash
git --version
```

If missing: `brew install git`.

---

## 2. Clone the repo

```bash
cd ~/Documents          # or wherever you want the project
git clone https://github.com/rjxznb/Get_Video.git
cd Get_Video/client
```

If the repo is private, you'll need to auth via:

```bash
gh auth login           # if you have GitHub CLI
# OR set up SSH key: https://docs.github.com/en/authentication/connecting-to-github-with-ssh
```

---

## 3. Install JS dependencies

From `Get_Video/client/`:

```bash
pnpm install
```

Takes ~1 min. Installs React, Vite, Tauri JS plugins, lucide-react, etc.

---

## 4. Acquire external binaries (the manual step)

Tauri's `bundle.externalBin` config expects the binaries at:

```
client/src-tauri/binaries/
  yt-dlp-aarch64-apple-darwin
  ffmpeg-aarch64-apple-darwin
  whisper-cli-aarch64-apple-darwin
```

(For Intel Macs, replace `aarch64` with `x86_64`.)

These three are NOT in the repo — they're gitignored due to size + license.
You acquire them manually as follows.

### 4.1 yt-dlp

Easiest: install via brew, copy + rename.

```bash
brew install yt-dlp

# Copy the binary into the repo's binaries/ folder (Apple Silicon path)
cp $(which yt-dlp) src-tauri/binaries/yt-dlp-aarch64-apple-darwin

# Verify it runs
src-tauri/binaries/yt-dlp-aarch64-apple-darwin --version
```

Alternative (no brew): download `yt-dlp_macos` from the
[official releases page](https://github.com/yt-dlp/yt-dlp/releases/latest)
and rename it.

### 4.2 ffmpeg

For a self-contained app build, you want a **statically-linked** ffmpeg
(otherwise it'll depend on Homebrew dylibs that won't exist on end-user
Macs). Download a static build from
[evermeet.cx](https://evermeet.cx/ffmpeg/) — they host signed static
binaries for both architectures:

```bash
# Apple Silicon (arm64):
curl -L https://evermeet.cx/ffmpeg/getrelease/zip -o /tmp/ffmpeg.zip
unzip /tmp/ffmpeg.zip -d /tmp/ffmpeg-bin
cp /tmp/ffmpeg-bin/ffmpeg src-tauri/binaries/ffmpeg-aarch64-apple-darwin
chmod +x src-tauri/binaries/ffmpeg-aarch64-apple-darwin

# Verify
src-tauri/binaries/ffmpeg-aarch64-apple-darwin -version
```

> **For Intel Mac users**: evermeet.cx serves arm64 by default. Get the Intel
> build via `https://evermeet.cx/ffmpeg/get/zip` (no architecture suffix is
> intel; with `-arm64` is Apple Silicon — confusingly opposite of what you'd
> expect; double-check with `file` after download).

If you're only building for personal use and don't care about distribution,
`brew install ffmpeg` + copying that binary is fine — it just won't run on
Macs that don't have brew + the same dylib versions.

### 4.3 whisper-cli (build from source)

There's no official prebuilt for macOS. Build it once with Metal acceleration
enabled (Apple GPU support, ~10x faster than CPU on M-series chips):

```bash
cd /tmp
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
git checkout v1.8.4   # match the version we use on Windows for parity

# Build with Metal acceleration (Apple Silicon GPU)
WHISPER_METAL=1 make -j

# The build produces ./main and ./whisper-cli
# Copy whisper-cli into the repo
cp ./whisper-cli ~/Documents/Get_Video/client/src-tauri/binaries/whisper-cli-aarch64-apple-darwin
chmod +x ~/Documents/Get_Video/client/src-tauri/binaries/whisper-cli-aarch64-apple-darwin

# Verify
~/Documents/Get_Video/client/src-tauri/binaries/whisper-cli-aarch64-apple-darwin --help
```

> **Metal vs CoreML**: `WHISPER_METAL=1` uses the GPU. On M1+ Macs this is the
> fastest option for free. CoreML support exists too but requires extra
> conversion steps; for our use case Metal is plenty fast.

> **About the DLLs from the Windows build**: macOS doesn't need them. The
> macOS build of whisper-cli statically links its dependencies (or links to
> system frameworks), so the single binary is self-contained. The
> `bundle.resources` glob `binaries/*.dll` in `tauri.conf.json` will simply
> match nothing on macOS, which is fine.

### 4.4 Verify all three are in place

```bash
cd ~/Documents/Get_Video/client
ls -la src-tauri/binaries/
# Should list:
#   ffmpeg-aarch64-apple-darwin
#   whisper-cli-aarch64-apple-darwin
#   yt-dlp-aarch64-apple-darwin
#   README.md
```

---

## 5. Run the dev build

From `client/`:

```bash
pnpm tauri dev
```

The first time:
- Vite starts immediately (~5 s)
- `cargo build` runs for the Rust backend — **first build is slow (5–15 min)**
  because it has to compile all of Tauri's deps (~600 crates)

Subsequent dev runs are fast (< 30 s incremental).

A native window will open. The app should start on the welcome screen
(prompt to configure LLM key + download Whisper model).

---

## 6. Production build

```bash
pnpm tauri build
```

This compiles in release mode (~3–10 min) and produces:

```
src-tauri/target/release/bundle/
├── dmg/
│   └── Get Video_0.1.0_aarch64.dmg     # Disk image installer
└── macos/
    └── Get Video.app/                   # Drag-to-Applications app bundle
```

The `.dmg` is what you'd give to end users. The `.app` is what gets installed.

### 6.1 Bundle size

Expect roughly:
- yt-dlp: ~25 MB
- ffmpeg: ~70 MB (static, full build)
- whisper-cli: ~3 MB (Metal version is small; backend compiled)
- Tauri runtime + JS bundle: ~15 MB
- Total `.dmg`: ~120 MB

The bundled Whisper model is **NOT** included — it downloads on first
launch (default `small` ≈ 466 MB).

### 6.2 Code signing & notarization (only if distributing)

For personal use, skip this. The unsigned `.app` will run; macOS will
show a "Cannot verify developer" dialog the first time, dismissed by:

```
System Settings → Privacy & Security → click "Open Anyway"
```

For distribution to others, you need:
1. Apple Developer Program membership ($99/year)
2. Set `tauri.conf.json` `bundle.macOS.signingIdentity` to your cert
3. After build: `xcrun notarytool submit ... && xcrun stapler staple ...`

Tauri docs on signing:
<https://v2.tauri.app/distribute/sign/macos/>

---

## 7. Architecture-specific gotcha (Apple Silicon vs Intel)

If you're on Intel Mac, every place this guide says `aarch64-apple-darwin`,
substitute `x86_64-apple-darwin`. The Cargo targets, Tauri externalBin
resolution, and binary filenames all need to match.

To check your CPU architecture:

```bash
uname -m
# arm64    → Apple Silicon → use aarch64
# x86_64   → Intel         → use x86_64
```

Apple Silicon Macs can run x86_64 binaries via Rosetta 2, so an Intel-built
`.app` will run on M-chip Macs at a perf cost. The reverse is not true —
arm64 binaries do not run on Intel Macs. To produce a **Universal** binary
covering both, see Tauri's docs on universal builds (requires building both
toolchains and lipo'ing the binaries).

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `cargo: command not found` | New terminal didn't reload PATH. `source $HOME/.cargo/env` or open new tab. |
| `xcrun: error: invalid active developer path` | Run `xcode-select --install` again. |
| Tauri build hangs at "Compiling tauri" for hours | First build always slow; if truly hung, kill and retry. Don't `cargo clean` between attempts — keep the cache. |
| Window opens but immediately crashes | Check Console.app → search "Get Video". Common cause: missing dylib for ffmpeg if you used brew binary. Re-do step 4.2 with a static build. |
| "Cannot verify developer" dialog blocks app | Right-click the `.app` → Open → confirm. macOS remembers and won't ask again. |
| `whisper-cli` won't run from app, works in terminal | Quarantine attribute on the binary. Run: `xattr -cr src-tauri/binaries/whisper-cli-*`. |
| Web Speech API has 0 voices | macOS comes with English voices preinstalled (Alex / Samantha / Karen / Daniel). If missing, System Settings → Accessibility → Spoken Content → "+" Add Voice. |

---

## 9. Quick recap (TL;DR)

```bash
# Toolchain (~20 min, one-time)
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
brew install node yt-dlp
npm install -g pnpm

# Project
git clone https://github.com/rjxznb/Get_Video.git
cd Get_Video/client
pnpm install

# Mac binaries
mkdir -p src-tauri/binaries
cp $(which yt-dlp) src-tauri/binaries/yt-dlp-aarch64-apple-darwin
curl -L https://evermeet.cx/ffmpeg/getrelease/zip -o /tmp/ffmpeg.zip
unzip /tmp/ffmpeg.zip -d /tmp/ffmpeg-bin
cp /tmp/ffmpeg-bin/ffmpeg src-tauri/binaries/ffmpeg-aarch64-apple-darwin
chmod +x src-tauri/binaries/ffmpeg-aarch64-apple-darwin
( cd /tmp && git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && git checkout v1.8.4 && WHISPER_METAL=1 make -j )
cp /tmp/whisper.cpp/whisper-cli src-tauri/binaries/whisper-cli-aarch64-apple-darwin
chmod +x src-tauri/binaries/whisper-cli-aarch64-apple-darwin

# Build
pnpm tauri dev      # development
pnpm tauri build    # production .dmg
```

---

## 10. References

- Tauri 2 setup: <https://v2.tauri.app/start/prerequisites/>
- Tauri 2 sidecar (externalBin): <https://v2.tauri.app/develop/sidecar/>
- whisper.cpp Metal build: <https://github.com/ggerganov/whisper.cpp#metal-support>
- ffmpeg static builds: <https://evermeet.cx/ffmpeg/>
- yt-dlp release: <https://github.com/yt-dlp/yt-dlp/releases/latest>
- App architecture (cross-platform overview): see `CLAUDE.md` in this folder
