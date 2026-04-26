# Video Analysis Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Tauri desktop client that lets users import a video (local file or URL), runs local Whisper transcription + LLM analysis, and presents the result in a left-video / right-tab learning view.

**Architecture:** Tauri 2 with Rust handling all subprocess work (yt-dlp, ffmpeg, whisper-cli) and library file IO. React + TypeScript frontend handles UI, LLM HTTP calls (OpenAI-compatible / Claude / Gemini SDKs), and the player. Communication via Tauri `invoke` commands and emitted events.

**Tech Stack:** Tauri 2 · Rust · React 18 · TypeScript · Vite · React Router v6 · zustand · Tailwind CSS · Vitest. External binaries: yt-dlp.exe, ffmpeg.exe, whisper-cli.exe (whisper.cpp). LLM SDKs: `openai`, `@anthropic-ai/sdk`, `@google/genai`.

**Spec:** `docs/superpowers/specs/2026-04-26-video-analysis-client-design.md`

---

## Conventions

- All work happens in the project root: `C:\Users\renjx\Desktop\Get_Video`
- The app lives in a new subdirectory: `client/`
- Rust code lives in `client/src-tauri/`
- TS code lives in `client/src/`
- Run all `cargo` / `npm` / `pnpm` commands from `client/` unless stated otherwise
- Use `pnpm` for JS package management (faster + smaller node_modules)
- After every task, commit with the conventional-commits style message in the step

---

## Phase 0: Project Setup

### Task 0.1: Initialize git repo

**Files:**
- Create: `.gitignore`

- [ ] **Step 1: Initialize git**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git init
```

- [ ] **Step 2: Create root .gitignore**

Write `.gitignore` at repo root:

```gitignore
# Dependencies
node_modules/
target/

# Build outputs
dist/
build/
*.exe
*.dll
*.dylib
*.so

# Tauri build artifacts
src-tauri/target/
src-tauri/Cargo.lock
src-tauri/binaries/

# IDE
.vscode/
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# Brainstorm session files
.superpowers/

# Whisper models (downloaded at runtime)
client/src-tauri/binaries/

# Existing video pipeline data (not part of the client)
data/
```

- [ ] **Step 3: Initial commit**

```bash
git add .gitignore docs/
git commit -m "chore: init repo with spec and plan"
```

### Task 0.2: Scaffold Tauri 2 + React + TS

**Files:**
- Create: `client/` (entire scaffold)

- [ ] **Step 1: Run create-tauri-app**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
pnpm create tauri-app@latest client --template react-ts --manager pnpm --identifier com.engHub.getvideo --tauri-version 2
```

When prompted, accept all defaults. The script creates `client/` with `src/`, `src-tauri/`, `package.json`, `tauri.conf.json`.

- [ ] **Step 2: Verify it builds and runs**

```bash
cd client
pnpm install
pnpm tauri dev
```

Expected: a window opens showing the default Tauri+React welcome page. Close it.

- [ ] **Step 3: Commit scaffold**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/
git commit -m "chore(client): scaffold Tauri 2 + React + TypeScript"
```

### Task 0.3: Install runtime deps

**Files:**
- Modify: `client/package.json`
- Modify: `client/src-tauri/Cargo.toml`

- [ ] **Step 1: Install JS deps**

```bash
cd client
pnpm add react-router-dom zustand openai @anthropic-ai/sdk @google/genai
pnpm add @tauri-apps/plugin-shell @tauri-apps/plugin-fs @tauri-apps/plugin-dialog @tauri-apps/plugin-http
```

- [ ] **Step 2: Install JS dev deps**

```bash
pnpm add -D tailwindcss postcss autoprefixer vitest @vitest/ui jsdom @testing-library/react happy-dom
pnpm add -D @types/node prettier eslint-config-prettier
```

- [ ] **Step 3: Initialize Tailwind**

```bash
pnpm dlx tailwindcss init -p
```

This creates `tailwind.config.js` and `postcss.config.js`.

- [ ] **Step 4: Configure Tailwind**

Replace `client/tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

Replace `client/src/App.css` with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 5: Add Rust deps**

Edit `client/src-tauri/Cargo.toml`. Keep the existing `tauri = "2"` and `serde`/`serde_json` lines that the scaffold added, then APPEND any of the following that are not already present under `[dependencies]`:

```toml
tauri-plugin-shell = "2"
tauri-plugin-fs = "2"
tauri-plugin-dialog = "2"
tauri-plugin-http = "2"
sha2 = "0.10"
hex = "0.4"
thiserror = "1"
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["stream"] }
futures-util = "0.3"
chrono = { version = "0.4", features = ["serde"] }
dirs = "5"
```

If `serde` exists without `derive` feature, change it to: `serde = { version = "1", features = ["derive"] }`.

- [ ] **Step 6: Verify everything still compiles**

```bash
pnpm tauri dev
```

Close after window opens.

- [ ] **Step 7: Commit**

```bash
git add client/package.json client/pnpm-lock.yaml client/src-tauri/Cargo.toml client/src-tauri/Cargo.lock client/tailwind.config.js client/postcss.config.js client/src/App.css
git commit -m "chore(client): install runtime + dev dependencies"
```

### Task 0.4: Configure Vitest

**Files:**
- Create: `client/vitest.config.ts`
- Modify: `client/package.json`

- [ ] **Step 1: Create vitest config**

Write `client/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
```

- [ ] **Step 2: Add npm scripts**

In `client/package.json`, under `"scripts"`, add:

```json
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 3: Verify**

```bash
cd client
pnpm test
```

Expected: "No test files found" — that's fine.

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/vitest.config.ts client/package.json
git commit -m "chore(client): configure vitest"
```

---

## Phase 1: Shared Types

### Task 1.1: Define TS types from analysis schema

**Files:**
- Create: `client/src/llm/types.ts`
- Test: `client/src/llm/types.test.ts`

- [ ] **Step 1: Write the failing test**

Write `client/src/llm/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Subtitle, KeyPhrase, AnalysisResult, RoleSetup, Scene } from "./types";

describe("types module", () => {
  it("Subtitle requires the EngHub fields", () => {
    const s: Subtitle = {
      time: 0,
      endTime: 1.5,
      text: "Hi",
      translation: "嗨",
      isKeyPoint: false,
      highlightWords: [],
      keyNotes: {},
      highlightTranslations: {},
    };
    expect(s.text).toBe("Hi");
  });

  it("AnalysisResult bundles subtitles + keyPhrases + roleSetup", () => {
    const a: AnalysisResult = {
      sceneContext: "ctx",
      subtitles: [],
      keyPhrases: [],
      roleSetup: {
        name: "Officer",
        identity: "Border officer",
        personality: "professional, polite",
        accent: "British",
      },
      complications: { medium: [], hard: [] },
      maxRounds: { easy: 4, medium: 6, hard: 10 },
      commonErrors: [],
      culturalNotes: "",
      country: "UK",
    };
    expect(a.country).toBe("UK");
  });

  it("Scene literal covers the 18 scenes", () => {
    const s: Scene = "immigration";
    expect(s).toBe("immigration");
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
cd client
pnpm test types
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement types.ts**

Write `client/src/llm/types.ts`:

```ts
export type Country = "US" | "UK" | "AU" | "CA";

export type Scene =
  | "immigration"
  | "housing"
  | "medical"
  | "campus"
  | "banking"
  | "shopping"
  | "transport"
  | "social"
  | "dining"
  | "emergency"
  | "job"
  | "phone"
  | "salon"
  | "driving"
  | "travel"
  | "fitness"
  | "mental_health"
  | "maintenance";

export const SCENE_LABELS: Record<Scene, string> = {
  immigration: "入境通关",
  housing: "住房安家",
  medical: "医疗健康",
  campus: "校园学习",
  banking: "银行财务",
  shopping: "日常购物",
  transport: "交通出行",
  social: "社交日常",
  dining: "餐饮",
  emergency: "紧急情况",
  job: "求职职场",
  phone: "电话沟通",
  salon: "美容美发",
  driving: "驾照开车",
  travel: "旅游度假",
  fitness: "运动健身",
  mental_health: "心理健康",
  maintenance: "搬家维修",
};

export interface Subtitle {
  time: number;
  endTime: number;
  text: string;
  translation: string;
  isKeyPoint: boolean;
  highlightWords: string[];
  keyNotes: Record<string, string>;
  highlightTranslations: Record<string, string>;
}

export type Register = "formal" | "casual" | "professional";
export type SpeakerRole = "learner" | "passive" | "both";
export type Difficulty = "EASY" | "MEDIUM" | "HARD";

export interface KeyPhrase {
  expression: string;
  meaningZh: string;
  usage: string;
  register: Register;
  speakerRole: SpeakerRole;
  minDifficulty: Difficulty;
}

export type Accent =
  | "American"
  | "American Female"
  | "British"
  | "British Female"
  | "Australian"
  | "Australian Female"
  | "Canadian"
  | "Canadian Female";

export interface RoleSetup {
  name: string;
  identity: string;
  personality: string;
  accent: Accent;
}

export interface AnalysisResult {
  sceneContext: string;
  subtitles: Subtitle[];
  keyPhrases: KeyPhrase[];
  roleSetup: RoleSetup;
  complications: { medium: string[]; hard: string[] };
  maxRounds: { easy: number; medium: number; hard: number };
  commonErrors: string[];
  culturalNotes: string;
  country: Country;
}

export interface SrtCue {
  index: number;
  time: number;
  endTime: number;
  text: string;
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
pnpm test types
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/llm/types.ts client/src/llm/types.test.ts
git commit -m "feat(client): add EngHub-compatible analysis types"
```

### Task 1.2: Define settings + library types

**Files:**
- Create: `client/src/types/settings.ts`
- Create: `client/src/types/library.ts`

- [ ] **Step 1: Write settings types**

Write `client/src/types/settings.ts`:

```ts
import type { Scene, Country } from "../llm/types";

export type LlmProvider = "openai-compatible" | "claude" | "gemini";

export type WhisperModelSize = "tiny" | "base" | "small" | "medium" | "large-v3";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ClaudeConfig {
  apiKey: string;
  model: string;
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
}

export interface Settings {
  llmProvider: LlmProvider;
  openaiCompatible: OpenAICompatibleConfig;
  claude: ClaudeConfig;
  gemini: GeminiConfig;
  whisperModel: WhisperModelSize;
  defaultScene: Scene;
  defaultCountry: Country;
}

export const DEFAULT_SETTINGS: Settings = {
  llmProvider: "openai-compatible",
  openaiCompatible: { baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-chat" },
  claude: { apiKey: "", model: "claude-sonnet-4-6" },
  gemini: { apiKey: "", model: "gemini-2.5-pro" },
  whisperModel: "small",
  defaultScene: "social",
  defaultCountry: "US",
};
```

- [ ] **Step 2: Write library types**

Write `client/src/types/library.ts`:

```ts
import type { Scene, Country } from "../llm/types";

export type LibrarySource =
  | { type: "local"; originalPath: string }
  | { type: "url"; url: string };

export type LibraryStatus = "analyzing" | "ready" | "failed";

export interface LibraryEntry {
  id: string;
  title: string;
  source: LibrarySource;
  scene: Scene;
  country: Country;
  durationSec: number;
  thumbnailPath: string;
  createdAt: string;
  status: LibraryStatus;
  lastError: string | null;
}

export interface Library {
  videos: LibraryEntry[];
}
```

- [ ] **Step 3: Verify typecheck**

```bash
cd client
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/types/
git commit -m "feat(client): add settings and library type definitions"
```

---

## Phase 2: Rust Core Utilities (pure)

### Task 2.1: Path resolution

**Files:**
- Create: `client/src-tauri/src/core/mod.rs`
- Create: `client/src-tauri/src/core/paths.rs`

- [ ] **Step 1: Write the failing test**

Append to `client/src-tauri/src/core/paths.rs`:

```rust
use std::path::PathBuf;

pub fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|d| d.join("Get_Video"))
        .ok_or_else(|| "could not determine data dir".to_string())
}

pub fn library_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("library"))
}

pub fn models_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("models"))
}

pub fn settings_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("settings.json"))
}

pub fn library_index_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("library.json"))
}

pub fn video_dir(video_id: &str) -> Result<PathBuf, String> {
    Ok(library_dir()?.join(video_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_dir_contains_get_video() {
        let p = app_data_dir().unwrap();
        assert!(p.to_string_lossy().contains("Get_Video"));
    }

    #[test]
    fn video_dir_under_library() {
        let v = video_dir("abc123").unwrap();
        let l = library_dir().unwrap();
        assert!(v.starts_with(&l));
        assert!(v.ends_with("abc123"));
    }
}
```

- [ ] **Step 2: Wire core module**

Write `client/src-tauri/src/core/mod.rs`:

```rust
pub mod paths;
```

Edit `client/src-tauri/src/lib.rs`, add at top:

```rust
mod core;
```

- [ ] **Step 3: Run tests**

```bash
cd client/src-tauri
cargo test paths
```

Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/core/ client/src-tauri/src/lib.rs
git commit -m "feat(rust): add app data path resolution"
```

### Task 2.2: video_id generation

**Files:**
- Create: `client/src-tauri/src/core/ids.rs`
- Modify: `client/src-tauri/src/core/mod.rs`

- [ ] **Step 1: Write the failing test**

Write `client/src-tauri/src/core/ids.rs`:

```rust
use sha2::{Digest, Sha256};
use std::path::Path;

pub fn id_from_file_hash(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    let hex = hex::encode(digest);
    Ok(hex[..12].to_string())
}

pub fn id_from_youtube_url(url: &str) -> Option<String> {
    // Match v=XXXXXXXXXXX (11 chars), youtu.be/XXXXXXXXXXX, or shorts/XXXXXXXXXXX
    let patterns = ["v=", "youtu.be/", "shorts/", "/embed/"];
    for p in &patterns {
        if let Some(idx) = url.find(p) {
            let start = idx + p.len();
            let candidate: String = url[start..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if candidate.len() == 11 {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn id_from_url_fallback(url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let hex = hex::encode(hasher.finalize());
    format!("u_{}", &hex[..10])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_v_param() {
        assert_eq!(
            id_from_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"),
            Some("dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn youtube_short() {
        assert_eq!(
            id_from_youtube_url("https://youtu.be/dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn youtube_shorts() {
        assert_eq!(
            id_from_youtube_url("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn non_youtube_returns_none() {
        assert_eq!(
            id_from_youtube_url("https://www.bilibili.com/video/BV1xx411c7mu"),
            None
        );
    }

    #[test]
    fn url_fallback_is_stable() {
        let a = id_from_url_fallback("https://example.com/video");
        let b = id_from_url_fallback("https://example.com/video");
        assert_eq!(a, b);
        assert!(a.starts_with("u_"));
        assert_eq!(a.len(), 12);
    }
}
```

- [ ] **Step 2: Wire module**

Edit `client/src-tauri/src/core/mod.rs`:

```rust
pub mod paths;
pub mod ids;
```

- [ ] **Step 3: Run tests**

```bash
cd client/src-tauri
cargo test ids
```

Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/core/
git commit -m "feat(rust): add video_id generators (file hash, YouTube, URL fallback)"
```

### Task 2.3: SRT parser

**Files:**
- Create: `client/src-tauri/src/core/srt.rs`
- Modify: `client/src-tauri/src/core/mod.rs`

- [ ] **Step 1: Write the failing test**

Write `client/src-tauri/src/core/srt.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SrtCue {
    pub index: usize,
    pub time: f64,
    pub end_time: f64,
    pub text: String,
}

pub fn parse(content: &str) -> Result<Vec<SrtCue>, String> {
    let mut cues = Vec::new();
    let blocks: Vec<&str> = content.split("\n\n").filter(|b| !b.trim().is_empty()).collect();

    for block in blocks {
        let lines: Vec<&str> = block.lines().collect();
        if lines.len() < 3 {
            continue;
        }
        let index: usize = lines[0].trim().parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
        let (time, end_time) = parse_timecode_line(lines[1])?;
        let text = lines[2..].join(" ").trim().to_string();
        cues.push(SrtCue { index, time, end_time, text });
    }

    Ok(cues)
}

fn parse_timecode_line(line: &str) -> Result<(f64, f64), String> {
    let parts: Vec<&str> = line.split("-->").collect();
    if parts.len() != 2 {
        return Err(format!("invalid timecode line: {line}"));
    }
    Ok((parse_timecode(parts[0].trim())?, parse_timecode(parts[1].trim())?))
}

fn parse_timecode(t: &str) -> Result<f64, String> {
    // SRT format: HH:MM:SS,mmm
    let normalized = t.replace(',', ".");
    let parts: Vec<&str> = normalized.split(':').collect();
    if parts.len() != 3 {
        return Err(format!("invalid timecode: {t}"));
    }
    let h: f64 = parts[0].parse().map_err(|e: std::num::ParseFloatError| e.to_string())?;
    let m: f64 = parts[1].parse().map_err(|e: std::num::ParseFloatError| e.to_string())?;
    let s: f64 = parts[2].parse().map_err(|e: std::num::ParseFloatError| e.to_string())?;
    Ok(h * 3600.0 + m * 60.0 + s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_cue() {
        let srt = "1\n00:00:01,000 --> 00:00:03,500\nHello world\n";
        let cues = parse(srt).unwrap();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].index, 1);
        assert_eq!(cues[0].time, 1.0);
        assert_eq!(cues[0].end_time, 3.5);
        assert_eq!(cues[0].text, "Hello world");
    }

    #[test]
    fn parses_multiple_cues() {
        let srt = "1\n00:00:01,000 --> 00:00:03,500\nFirst\n\n2\n00:00:04,200 --> 00:00:06,800\nSecond line\nstill second\n";
        let cues = parse(srt).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[1].text, "Second line still second");
    }

    #[test]
    fn handles_hour_timecodes() {
        let srt = "1\n01:02:03,456 --> 01:02:05,000\nLater\n";
        let cues = parse(srt).unwrap();
        assert_eq!(cues[0].time, 3723.456);
    }

    #[test]
    fn rejects_invalid_timecode() {
        let srt = "1\nbroken\nText\n";
        assert!(parse(srt).is_err());
    }
}
```

- [ ] **Step 2: Wire module**

Edit `client/src-tauri/src/core/mod.rs`:

```rust
pub mod paths;
pub mod ids;
pub mod srt;
```

- [ ] **Step 3: Run tests**

```bash
cd client/src-tauri
cargo test srt
```

Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/core/
git commit -m "feat(rust): add SRT parser for whisper.cpp output"
```

### Task 2.4: Unified error type

**Files:**
- Create: `client/src-tauri/src/error.rs`
- Modify: `client/src-tauri/src/lib.rs`

- [ ] **Step 1: Write error type**

Write `client/src-tauri/src/error.rs`:

```rust
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("subprocess failed: {0}")]
    Subprocess(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("network: {0}")]
    Network(#[from] reqwest::Error),

    #[error("{0}")]
    Other(String),
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Other(s)
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
```

- [ ] **Step 2: Add to lib.rs**

Edit `client/src-tauri/src/lib.rs`, append:

```rust
mod error;
```

- [ ] **Step 3: Verify compiles**

```bash
cd client/src-tauri
cargo build
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/
git commit -m "feat(rust): add unified AppError type"
```

### Task 2.5: Progress event types

**Files:**
- Create: `client/src-tauri/src/core/progress.rs`
- Modify: `client/src-tauri/src/core/mod.rs`

- [ ] **Step 1: Write progress module**

Write `client/src-tauri/src/core/progress.rs`:

```rust
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage")]
pub enum PipelineEvent {
    Started { video_id: String },
    Downloading { video_id: String, percent: u8 },
    ExtractingAudio { video_id: String },
    Transcribing { video_id: String, percent: u8 },
    Transcribed { video_id: String, srt_path: String, duration_sec: f64 },
    Failed { video_id: String, error: String },
    ModelDownload { progress: u8, total_mb: u64, downloaded_mb: u64 },
}

pub fn emit(app: &AppHandle, event: PipelineEvent) {
    let _ = app.emit("pipeline-event", event);
}
```

- [ ] **Step 2: Wire module**

Edit `client/src-tauri/src/core/mod.rs`:

```rust
pub mod paths;
pub mod ids;
pub mod srt;
pub mod progress;
```

- [ ] **Step 3: Verify compiles**

```bash
cd client/src-tauri
cargo build
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/core/
git commit -m "feat(rust): add pipeline progress event types"
```

---

## Phase 3: Rust Settings + Library

### Task 3.1: Settings command

**Files:**
- Create: `client/src-tauri/src/commands/mod.rs`
- Create: `client/src-tauri/src/commands/settings.rs`

- [ ] **Step 1: Write commands module file**

Write `client/src-tauri/src/commands/mod.rs`:

```rust
pub mod settings;
```

- [ ] **Step 2: Write settings command**

Write `client/src-tauri/src/commands/settings.rs`:

```rust
use crate::core::paths;
use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::fs;

#[tauri::command]
pub fn get_settings() -> AppResult<Value> {
    let path = paths::settings_path()?;
    if !path.exists() {
        return Ok(Value::Null);
    }
    let raw = fs::read_to_string(&path)?;
    let v: Value = serde_json::from_str(&raw)?;
    Ok(v)
}

#[tauri::command]
pub fn save_settings(settings: Value) -> AppResult<()> {
    let dir = paths::app_data_dir()?;
    fs::create_dir_all(&dir)?;
    let path = paths::settings_path()?;
    let pretty = serde_json::to_string_pretty(&settings)?;
    fs::write(&path, pretty)?;
    Ok(())
}

#[tauri::command]
pub fn settings_path_string() -> AppResult<String> {
    Ok(paths::settings_path()?.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn save_then_get_roundtrips() {
        let payload = json!({"llmProvider": "claude", "claude": {"apiKey": "k"}});
        save_settings(payload.clone()).unwrap();
        let back = get_settings().unwrap();
        assert_eq!(back, payload);
    }
}
```

- [ ] **Step 3: Wire commands module**

Edit `client/src-tauri/src/lib.rs`, append:

```rust
mod commands;
```

- [ ] **Step 4: Run test**

```bash
cd client/src-tauri
cargo test settings
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/
git commit -m "feat(rust): add get_settings + save_settings commands"
```

### Task 3.2: Library commands

**Files:**
- Create: `client/src-tauri/src/commands/library.rs`
- Modify: `client/src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Write library types**

Write `client/src-tauri/src/commands/library.rs`:

```rust
use crate::core::paths;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LibrarySource {
    #[serde(rename = "local")]
    Local { #[serde(rename = "originalPath")] original_path: String },
    #[serde(rename = "url")]
    Url { url: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum LibraryStatus {
    #[serde(rename = "analyzing")]
    Analyzing,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "failed")]
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub title: String,
    pub source: LibrarySource,
    pub scene: String,
    pub country: String,
    pub duration_sec: f64,
    pub thumbnail_path: String,
    pub created_at: String,
    pub status: LibraryStatus,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Library {
    pub videos: Vec<LibraryEntry>,
}

fn read_index() -> AppResult<Library> {
    let path = paths::library_index_path()?;
    if !path.exists() {
        return Ok(Library::default());
    }
    let raw = fs::read_to_string(&path)?;
    let lib: Library = serde_json::from_str(&raw)?;
    Ok(lib)
}

fn write_index(lib: &Library) -> AppResult<()> {
    let dir = paths::app_data_dir()?;
    fs::create_dir_all(&dir)?;
    let pretty = serde_json::to_string_pretty(lib)?;
    fs::write(paths::library_index_path()?, pretty)?;
    Ok(())
}

#[tauri::command]
pub fn library_list() -> AppResult<Library> {
    read_index()
}

#[tauri::command]
pub fn library_get(id: String) -> AppResult<Option<LibraryEntry>> {
    let lib = read_index()?;
    Ok(lib.videos.into_iter().find(|v| v.id == id))
}

#[tauri::command]
pub fn library_upsert(entry: LibraryEntry) -> AppResult<()> {
    let mut lib = read_index()?;
    if let Some(existing) = lib.videos.iter_mut().find(|v| v.id == entry.id) {
        *existing = entry;
    } else {
        lib.videos.push(entry);
    }
    write_index(&lib)
}

#[tauri::command]
pub fn library_delete(id: String) -> AppResult<()> {
    let mut lib = read_index()?;
    lib.videos.retain(|v| v.id != id);
    write_index(&lib)?;
    let dir = paths::video_dir(&id)?;
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    Ok(())
}

#[tauri::command]
pub fn library_set_status(id: String, status: LibraryStatus, error: Option<String>) -> AppResult<()> {
    let mut lib = read_index()?;
    if let Some(entry) = lib.videos.iter_mut().find(|v| v.id == id) {
        entry.status = status;
        entry.last_error = error;
    }
    write_index(&lib)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> LibraryEntry {
        LibraryEntry {
            id: id.into(),
            title: "Sample".into(),
            source: LibrarySource::Local { original_path: "/x".into() },
            scene: "social".into(),
            country: "US".into(),
            duration_sec: 10.0,
            thumbnail_path: "thumb.jpg".into(),
            created_at: "2026-04-26T00:00:00Z".into(),
            status: LibraryStatus::Analyzing,
            last_error: None,
        }
    }

    #[test]
    fn upsert_creates_then_updates() {
        // Clean slate
        let _ = fs::remove_file(paths::library_index_path().unwrap());

        library_upsert(sample("a")).unwrap();
        let lib = library_list().unwrap();
        assert_eq!(lib.videos.len(), 1);

        let mut updated = sample("a");
        updated.title = "Updated".into();
        library_upsert(updated).unwrap();
        let lib = library_list().unwrap();
        assert_eq!(lib.videos.len(), 1);
        assert_eq!(lib.videos[0].title, "Updated");
    }

    #[test]
    fn set_status_updates_field() {
        let _ = fs::remove_file(paths::library_index_path().unwrap());
        library_upsert(sample("b")).unwrap();
        library_set_status("b".into(), LibraryStatus::Ready, None).unwrap();
        let entry = library_get("b".into()).unwrap().unwrap();
        assert_eq!(entry.status, LibraryStatus::Ready);
    }
}
```

- [ ] **Step 2: Wire module**

Edit `client/src-tauri/src/commands/mod.rs`:

```rust
pub mod settings;
pub mod library;
```

- [ ] **Step 3: Run test (serial since they touch shared file)**

```bash
cd client/src-tauri
cargo test library -- --test-threads=1
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/commands/
git commit -m "feat(rust): add library index commands (list/get/upsert/delete/set_status)"
```

### Task 3.3: Analysis save command

**Files:**
- Create: `client/src-tauri/src/commands/analysis.rs`
- Modify: `client/src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Write analysis command**

Write `client/src-tauri/src/commands/analysis.rs`:

```rust
use crate::core::paths;
use crate::error::AppResult;
use serde_json::Value;
use std::fs;

#[tauri::command]
pub fn save_analysis(video_id: String, analysis: Value) -> AppResult<()> {
    let dir = paths::video_dir(&video_id)?;
    fs::create_dir_all(&dir)?;
    let path = dir.join("analysis.json");
    let pretty = serde_json::to_string_pretty(&analysis)?;
    fs::write(&path, pretty)?;
    Ok(())
}

#[tauri::command]
pub fn load_analysis(video_id: String) -> AppResult<Option<Value>> {
    let path = paths::video_dir(&video_id)?.join("analysis.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    Ok(Some(serde_json::from_str(&raw)?))
}

#[tauri::command]
pub fn load_transcript(video_id: String) -> AppResult<Option<String>> {
    let path = paths::video_dir(&video_id)?.join("transcript.srt");
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(&path)?))
}

#[tauri::command]
pub fn video_source_path(video_id: String) -> AppResult<String> {
    let path = paths::video_dir(&video_id)?.join("source.mp4");
    Ok(path.to_string_lossy().to_string())
}
```

- [ ] **Step 2: Wire module**

Edit `client/src-tauri/src/commands/mod.rs`:

```rust
pub mod settings;
pub mod library;
pub mod analysis;
```

- [ ] **Step 3: Verify compiles**

```bash
cd client/src-tauri
cargo build
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/commands/
git commit -m "feat(rust): add analysis save/load + video source path commands"
```

---

## Phase 4: Acquire External Binaries

### Task 4.1: Place yt-dlp + ffmpeg + whisper-cli into binaries/

**Files:**
- Create: `client/src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe`
- Create: `client/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe`
- Create: `client/src-tauri/binaries/whisper-cli-x86_64-pc-windows-msvc.exe`
- Create: `client/src-tauri/binaries/.gitkeep`
- Create: `client/src-tauri/binaries/README.md`

> **Why this is a manual task:** these are large binaries that can't be checked in. The README documents the source URLs and target filenames.

- [ ] **Step 1: Create binaries dir**

```bash
cd "C:/Users/renjx/Desktop/Get_Video/client/src-tauri"
mkdir -p binaries
touch binaries/.gitkeep
```

- [ ] **Step 2: Write README documenting binary sources**

Write `client/src-tauri/binaries/README.md`:

```md
# Bundled External Binaries

These binaries are bundled into the installer via Tauri's `externalBin` mechanism.
They are NOT checked into git (see .gitignore).

## Required files (Windows x64)

| File | Source | Notes |
|---|---|---|
| `yt-dlp-x86_64-pc-windows-msvc.exe` | https://github.com/yt-dlp/yt-dlp/releases/latest → `yt-dlp.exe` | Rename after download |
| `ffmpeg-x86_64-pc-windows-msvc.exe` | https://www.gyan.dev/ffmpeg/builds/ → "release essentials" zip → `bin/ffmpeg.exe` | Extract and rename |
| `whisper-cli-x86_64-pc-windows-msvc.exe` | https://github.com/ggerganov/whisper.cpp/releases/latest → `whisper-bin-x64.zip` → `Release/whisper-cli.exe` | If the latest release lacks Windows binaries, build from source: `cmake -B build && cmake --build build --config Release` |

## Verification

After placing all three files, run:

```bash
./yt-dlp-x86_64-pc-windows-msvc.exe --version
./ffmpeg-x86_64-pc-windows-msvc.exe -version
./whisper-cli-x86_64-pc-windows-msvc.exe --help
```

All three should exit 0 with their respective output.
```

- [ ] **Step 3: Manually download all three binaries to this directory**

Follow the README above. After this step you should have:

```
client/src-tauri/binaries/
  yt-dlp-x86_64-pc-windows-msvc.exe
  ffmpeg-x86_64-pc-windows-msvc.exe
  whisper-cli-x86_64-pc-windows-msvc.exe
  .gitkeep
  README.md
```

- [ ] **Step 4: Smoke-test each binary**

```bash
cd client/src-tauri/binaries
./yt-dlp-x86_64-pc-windows-msvc.exe --version
./ffmpeg-x86_64-pc-windows-msvc.exe -version | head -1
./whisper-cli-x86_64-pc-windows-msvc.exe --help | head -3
```

Each should produce non-error output.

- [ ] **Step 5: Commit (only the README + .gitkeep, binaries excluded by .gitignore)**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/binaries/.gitkeep client/src-tauri/binaries/README.md
git commit -m "docs(client): document external binary acquisition"
```

### Task 4.2: Configure Tauri sidecar bundling

**Files:**
- Modify: `client/src-tauri/tauri.conf.json`
- Create: `client/src-tauri/capabilities/default.json` (or modify existing)

- [ ] **Step 1: Edit tauri.conf.json to declare external binaries**

Open `client/src-tauri/tauri.conf.json`. Find the `bundle` section, add `externalBin`:

```json
{
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/icon.png"],
    "externalBin": [
      "binaries/yt-dlp",
      "binaries/ffmpeg",
      "binaries/whisper-cli"
    ]
  }
}
```

(Tauri appends `-{target-triple}.exe` automatically based on the build target.)

- [ ] **Step 2: Configure capabilities for shell sidecar**

Open `client/src-tauri/capabilities/default.json`. Replace its `permissions` array with:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:default",
    "fs:default",
    "dialog:default",
    "http:default",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        { "name": "binaries/yt-dlp", "sidecar": true, "args": true },
        { "name": "binaries/ffmpeg", "sidecar": true, "args": true },
        { "name": "binaries/whisper-cli", "sidecar": true, "args": true }
      ]
    }
  ]
}
```

- [ ] **Step 3: Register Tauri plugins in Rust**

Edit `client/src-tauri/src/lib.rs`. Inside the `pub fn run()` (or `tauri::Builder::default()`), add plugins:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::settings_path_string,
            commands::library::library_list,
            commands::library::library_get,
            commands::library::library_upsert,
            commands::library::library_delete,
            commands::library::library_set_status,
            commands::analysis::save_analysis,
            commands::analysis::load_analysis,
            commands::analysis::load_transcript,
            commands::analysis::video_source_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Build and verify**

```bash
cd client
pnpm tauri dev
```

Expected: window opens; no startup errors in terminal.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/tauri.conf.json client/src-tauri/capabilities/default.json client/src-tauri/src/lib.rs
git commit -m "feat(rust): configure Tauri sidecar bundling + plugins + invoke handlers"
```

---

## Phase 5: Rust Pipeline (subprocess orchestration)

### Task 5.1: Pipeline helper — sidecar spawn wrapper

**Files:**
- Create: `client/src-tauri/src/pipeline/mod.rs`
- Create: `client/src-tauri/src/pipeline/spawn.rs`
- Modify: `client/src-tauri/src/lib.rs`

- [ ] **Step 1: Write spawn helper**

Write `client/src-tauri/src/pipeline/spawn.rs`:

```rust
use crate::error::{AppError, AppResult};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

/// Run a sidecar to completion, capturing stdout. Streams stderr to a callback for progress parsing.
pub async fn run_sidecar<F>(
    app: &AppHandle,
    bin_name: &str,
    args: &[&str],
    mut on_stderr_line: F,
) -> AppResult<String>
where
    F: FnMut(&str),
{
    let cmd = app
        .shell()
        .sidecar(bin_name)
        .map_err(|e| AppError::Subprocess(format!("sidecar {bin_name}: {e}")))?
        .args(args);

    let (mut rx, _child) = cmd
        .spawn()
        .map_err(|e| AppError::Subprocess(format!("spawn {bin_name}: {e}")))?;

    let mut stdout = String::new();
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                on_stderr_line(&line);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    match exit_code {
        Some(0) => Ok(stdout),
        Some(c) => Err(AppError::Subprocess(format!("{bin_name} exit {c}"))),
        None => Err(AppError::Subprocess(format!("{bin_name} terminated abnormally"))),
    }
}
```

- [ ] **Step 2: Wire pipeline module**

Write `client/src-tauri/src/pipeline/mod.rs`:

```rust
pub mod spawn;
```

Edit `client/src-tauri/src/lib.rs`, append:

```rust
mod pipeline;
```

- [ ] **Step 3: Verify compiles**

```bash
cd client/src-tauri
cargo build
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/
git commit -m "feat(rust): add sidecar spawn helper with stderr streaming"
```

### Task 5.2: yt-dlp wrapper

**Files:**
- Create: `client/src-tauri/src/pipeline/ytdlp.rs`
- Modify: `client/src-tauri/src/pipeline/mod.rs`

- [ ] **Step 1: Write yt-dlp wrapper**

Write `client/src-tauri/src/pipeline/ytdlp.rs`:

```rust
use crate::core::progress::{emit, PipelineEvent};
use crate::error::AppResult;
use crate::pipeline::spawn::run_sidecar;
use std::path::Path;
use tauri::AppHandle;

#[derive(Debug)]
pub struct DownloadResult {
    pub video_path: String,
    pub thumb_path: String,
    pub title: String,
    pub duration_sec: f64,
}

/// Download a video to `out_dir/source.mp4` and `out_dir/thumb.jpg`.
pub async fn download(
    app: &AppHandle,
    url: &str,
    out_dir: &Path,
    video_id: &str,
) -> AppResult<DownloadResult> {
    std::fs::create_dir_all(out_dir)?;
    let video_path = out_dir.join("source.mp4").to_string_lossy().to_string();
    let thumb_path = out_dir.join("thumb.jpg").to_string_lossy().to_string();
    let info_path = out_dir.join("info.json").to_string_lossy().to_string();

    // Single yt-dlp call: download video + thumbnail + write info.json
    let id = video_id.to_string();
    let app_clone = app.clone();
    run_sidecar(
        app,
        "binaries/yt-dlp",
        &[
            "-f",
            "bv*[ext=mp4][height<=720]+ba/best[ext=mp4]/best",
            "--merge-output-format",
            "mp4",
            "-o",
            &video_path,
            "--write-thumbnail",
            "--convert-thumbnails",
            "jpg",
            "-o",
            &format!("thumbnail:{}", thumb_path.trim_end_matches(".jpg")),
            "--write-info-json",
            "-o",
            &format!("infojson:{}", info_path.trim_end_matches(".json")),
            "--newline",
            "--progress-template",
            "[download] %(progress._percent_str)s",
            url,
        ],
        |line| {
            if let Some(p) = parse_percent(line) {
                emit(&app_clone, PipelineEvent::Downloading { video_id: id.clone(), percent: p });
            }
        },
    )
    .await?;

    let info: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&info_path)?)?;
    let title = info.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string();
    let duration = info.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);

    Ok(DownloadResult { video_path, thumb_path, title, duration_sec: duration })
}

fn parse_percent(line: &str) -> Option<u8> {
    // Match "[download]   42.3%" or our template "[download] 42.3%"
    let stripped = line.trim();
    let pct_str = stripped.split('%').next()?.split_whitespace().last()?;
    let pct: f32 = pct_str.parse().ok()?;
    Some(pct.clamp(0.0, 100.0) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_percent_from_progress_line() {
        assert_eq!(parse_percent("[download]   42.3% of 10.5MiB"), Some(42));
        assert_eq!(parse_percent("[download] 100.0%"), Some(100));
        assert_eq!(parse_percent("not a progress line"), None);
    }
}
```

- [ ] **Step 2: Wire module**

Edit `client/src-tauri/src/pipeline/mod.rs`:

```rust
pub mod spawn;
pub mod ytdlp;
```

- [ ] **Step 3: Run unit test**

```bash
cd client/src-tauri
cargo test ytdlp
```

Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/pipeline/
git commit -m "feat(rust): add yt-dlp wrapper for video+thumbnail+info download"
```

### Task 5.3: ffmpeg audio extraction

**Files:**
- Create: `client/src-tauri/src/pipeline/ffmpeg.rs`
- Modify: `client/src-tauri/src/pipeline/mod.rs`

- [ ] **Step 1: Write ffmpeg wrapper**

Write `client/src-tauri/src/pipeline/ffmpeg.rs`:

```rust
use crate::error::AppResult;
use crate::pipeline::spawn::run_sidecar;
use std::path::Path;
use tauri::AppHandle;

/// Convert any video to 16kHz mono PCM WAV at `out_path`. Whisper.cpp expects this format.
pub async fn extract_audio_wav(app: &AppHandle, video_path: &Path, out_path: &Path) -> AppResult<()> {
    let video_str = video_path.to_string_lossy().to_string();
    let out_str = out_path.to_string_lossy().to_string();
    run_sidecar(
        app,
        "binaries/ffmpeg",
        &[
            "-y",
            "-i", &video_str,
            "-vn",
            "-ac", "1",
            "-ar", "16000",
            "-c:a", "pcm_s16le",
            &out_str,
        ],
        |_| {},
    )
    .await?;
    Ok(())
}

/// Extract first frame as JPEG thumbnail at `out_path`.
pub async fn extract_thumbnail(app: &AppHandle, video_path: &Path, out_path: &Path) -> AppResult<()> {
    let video_str = video_path.to_string_lossy().to_string();
    let out_str = out_path.to_string_lossy().to_string();
    run_sidecar(
        app,
        "binaries/ffmpeg",
        &[
            "-y",
            "-ss", "0.5",
            "-i", &video_str,
            "-vframes", "1",
            "-q:v", "2",
            &out_str,
        ],
        |_| {},
    )
    .await?;
    Ok(())
}
```

- [ ] **Step 2: Wire module**

Edit `client/src-tauri/src/pipeline/mod.rs`:

```rust
pub mod spawn;
pub mod ytdlp;
pub mod ffmpeg;
```

- [ ] **Step 3: Verify compiles**

```bash
cd client/src-tauri
cargo build
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/pipeline/
git commit -m "feat(rust): add ffmpeg wrapper (audio extract + thumbnail)"
```

### Task 5.4: Whisper transcription

**Files:**
- Create: `client/src-tauri/src/pipeline/whisper.rs`
- Modify: `client/src-tauri/src/pipeline/mod.rs`

- [ ] **Step 1: Write whisper wrapper**

Write `client/src-tauri/src/pipeline/whisper.rs`:

```rust
use crate::core::paths;
use crate::core::progress::{emit, PipelineEvent};
use crate::error::{AppError, AppResult};
use crate::pipeline::spawn::run_sidecar;
use std::path::Path;
use tauri::AppHandle;

const MODEL_URLS: &[(&str, &str, u64)] = &[
    ("tiny",     "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",     75),
    ("base",     "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",     145),
    ("small",    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",    466),
    ("medium",   "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",   1500),
    ("large-v3", "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin", 3094),
];

pub fn model_info(size: &str) -> Option<(&'static str, u64)> {
    MODEL_URLS.iter().find(|(s, _, _)| *s == size).map(|(_, url, mb)| (*url, *mb))
}

pub fn model_path(size: &str) -> AppResult<std::path::PathBuf> {
    Ok(paths::models_dir()?.join(format!("ggml-{size}.bin")))
}

pub fn model_exists(size: &str) -> AppResult<bool> {
    Ok(model_path(size)?.exists())
}

pub async fn download_model(app: &AppHandle, size: &str) -> AppResult<()> {
    let (url, total_mb) = model_info(size).ok_or_else(|| AppError::InvalidInput(format!("unknown model: {size}")))?;
    let dest = model_path(size)?;
    std::fs::create_dir_all(dest.parent().unwrap())?;

    let resp = reqwest::get(url).await?;
    let total_bytes = resp.content_length().unwrap_or(total_mb * 1024 * 1024);
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = 0;

    use futures_util::StreamExt;
    use std::io::Write;
    let mut file = std::fs::File::create(&dest)?;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        file.write_all(&bytes)?;
        downloaded += bytes.len() as u64;
        let pct = ((downloaded as f64 / total_bytes as f64) * 100.0) as u8;
        if pct != last_percent {
            last_percent = pct;
            emit(app, PipelineEvent::ModelDownload {
                progress: pct,
                total_mb: total_bytes / 1024 / 1024,
                downloaded_mb: downloaded / 1024 / 1024,
            });
        }
    }
    Ok(())
}

pub async fn transcribe(
    app: &AppHandle,
    audio_path: &Path,
    out_dir: &Path,
    model_size: &str,
    video_id: &str,
) -> AppResult<std::path::PathBuf> {
    let model = model_path(model_size)?;
    if !model.exists() {
        return Err(AppError::NotFound(format!("model not downloaded: {model_size}")));
    }

    let audio_str = audio_path.to_string_lossy().to_string();
    let model_str = model.to_string_lossy().to_string();
    // whisper-cli writes <audio>.srt next to the audio file when -osrt is given,
    // unless -of is used to override the output base path.
    let out_base = out_dir.join("transcript").to_string_lossy().to_string();

    let id = video_id.to_string();
    let app_clone = app.clone();
    run_sidecar(
        app,
        "binaries/whisper-cli",
        &[
            "-m", &model_str,
            "-f", &audio_str,
            "-l", "en",
            "-osrt",
            "-of", &out_base,
            "--print-progress",
        ],
        |line| {
            if let Some(p) = parse_progress(line) {
                emit(&app_clone, PipelineEvent::Transcribing { video_id: id.clone(), percent: p });
            }
        },
    )
    .await?;

    Ok(out_dir.join("transcript.srt"))
}

fn parse_progress(line: &str) -> Option<u8> {
    // whisper.cpp prints "whisper_print_progress_callback: progress = 42%"
    let trimmed = line.trim();
    if let Some(idx) = trimmed.find("progress =") {
        let rest = &trimmed[idx + "progress =".len()..];
        let pct_str = rest.trim().trim_end_matches('%').trim();
        return pct_str.parse::<u8>().ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_whisper_progress_line() {
        assert_eq!(
            parse_progress("whisper_print_progress_callback: progress = 42%"),
            Some(42)
        );
        assert_eq!(parse_progress("noise"), None);
    }

    #[test]
    fn model_info_known_size() {
        assert!(model_info("small").is_some());
        assert!(model_info("nonexistent").is_none());
    }
}
```

- [ ] **Step 2: Wire module**

Edit `client/src-tauri/src/pipeline/mod.rs`:

```rust
pub mod spawn;
pub mod ytdlp;
pub mod ffmpeg;
pub mod whisper;
```

- [ ] **Step 3: Run unit tests**

```bash
cd client/src-tauri
cargo test whisper
```

Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/pipeline/
git commit -m "feat(rust): add Whisper transcription + model download"
```

### Task 5.5: Model commands

**Files:**
- Create: `client/src-tauri/src/commands/models.rs`
- Modify: `client/src-tauri/src/commands/mod.rs`
- Modify: `client/src-tauri/src/lib.rs`

- [ ] **Step 1: Write commands**

Write `client/src-tauri/src/commands/models.rs`:

```rust
use crate::error::AppResult;
use crate::pipeline::whisper;
use tauri::AppHandle;

#[tauri::command]
pub fn whisper_model_status(size: String) -> AppResult<bool> {
    whisper::model_exists(&size)
}

#[tauri::command]
pub async fn whisper_model_download(app: AppHandle, size: String) -> AppResult<()> {
    whisper::download_model(&app, &size).await
}
```

- [ ] **Step 2: Wire module + register handlers**

Edit `client/src-tauri/src/commands/mod.rs`:

```rust
pub mod settings;
pub mod library;
pub mod analysis;
pub mod models;
```

Edit `client/src-tauri/src/lib.rs`, add to `invoke_handler!`:

```rust
commands::models::whisper_model_status,
commands::models::whisper_model_download,
```

- [ ] **Step 3: Verify compiles**

```bash
cd client/src-tauri
cargo build
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/
git commit -m "feat(rust): expose whisper model status + download commands"
```

### Task 5.6: Import command (orchestrates the full pipeline up to transcription)

**Files:**
- Create: `client/src-tauri/src/commands/import.rs`
- Modify: `client/src-tauri/src/commands/mod.rs`
- Modify: `client/src-tauri/src/lib.rs`

- [ ] **Step 1: Write the command**

Write `client/src-tauri/src/commands/import.rs`:

```rust
use crate::commands::library::{library_upsert, LibraryEntry, LibrarySource, LibraryStatus};
use crate::core::ids;
use crate::core::paths;
use crate::core::progress::{emit, PipelineEvent};
use crate::error::{AppError, AppResult};
use crate::pipeline::{ffmpeg, whisper, ytdlp};
use chrono::Utc;
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub source_kind: String,        // "local" | "url"
    pub source_value: String,       // path or URL
    pub scene: String,
    pub country: String,
    pub whisper_model: String,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub video_id: String,
    pub srt_path: String,
    pub duration_sec: f64,
}

#[tauri::command]
pub async fn import_video(app: AppHandle, req: ImportRequest) -> AppResult<ImportResult> {
    // 1. Determine video_id
    let video_id = match req.source_kind.as_str() {
        "url" => ids::id_from_youtube_url(&req.source_value)
            .unwrap_or_else(|| ids::id_from_url_fallback(&req.source_value)),
        "local" => ids::id_from_file_hash(std::path::Path::new(&req.source_value))?,
        _ => return Err(AppError::InvalidInput(format!("source_kind: {}", req.source_kind))),
    };

    let out_dir = paths::video_dir(&video_id)?;
    std::fs::create_dir_all(&out_dir)?;

    emit(&app, PipelineEvent::Started { video_id: video_id.clone() });

    // 2. Acquire source.mp4 + thumb.jpg + title + duration
    let (video_path, thumb_path, title, duration_sec) = match req.source_kind.as_str() {
        "url" => {
            let r = ytdlp::download(&app, &req.source_value, &out_dir, &video_id).await?;
            (PathBuf::from(r.video_path), PathBuf::from(r.thumb_path), r.title, r.duration_sec)
        }
        "local" => {
            let dest = out_dir.join("source.mp4");
            std::fs::copy(&req.source_value, &dest)?;
            let thumb = out_dir.join("thumb.jpg");
            ffmpeg::extract_thumbnail(&app, &dest, &thumb).await?;
            let title = std::path::Path::new(&req.source_value)
                .file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled").to_string();
            // We don't probe duration here; UI will read it from <video> on load.
            (dest, thumb, title, 0.0)
        }
        _ => unreachable!(),
    };

    // 3. Insert library entry as "analyzing"
    let entry = LibraryEntry {
        id: video_id.clone(),
        title,
        source: match req.source_kind.as_str() {
            "url" => LibrarySource::Url { url: req.source_value.clone() },
            _ => LibrarySource::Local { original_path: req.source_value.clone() },
        },
        scene: req.scene.clone(),
        country: req.country.clone(),
        duration_sec,
        thumbnail_path: thumb_path.to_string_lossy().to_string(),
        created_at: Utc::now().to_rfc3339(),
        status: LibraryStatus::Analyzing,
        last_error: None,
    };
    library_upsert(entry)?;

    // 4. Extract audio
    emit(&app, PipelineEvent::ExtractingAudio { video_id: video_id.clone() });
    let audio_path = out_dir.join("audio.wav");
    ffmpeg::extract_audio_wav(&app, &video_path, &audio_path).await?;

    // 5. Transcribe
    let srt_path = whisper::transcribe(&app, &audio_path, &out_dir, &req.whisper_model, &video_id).await?;
    let dur_sec = std::fs::metadata(&audio_path).map(|m| m.len() as f64 / (16000.0 * 2.0)).unwrap_or(0.0);

    emit(&app, PipelineEvent::Transcribed {
        video_id: video_id.clone(),
        srt_path: srt_path.to_string_lossy().to_string(),
        duration_sec: dur_sec,
    });

    Ok(ImportResult {
        video_id,
        srt_path: srt_path.to_string_lossy().to_string(),
        duration_sec: dur_sec,
    })
}
```

- [ ] **Step 2: Wire and register**

Edit `client/src-tauri/src/commands/mod.rs`:

```rust
pub mod settings;
pub mod library;
pub mod analysis;
pub mod models;
pub mod import;
```

Add to `invoke_handler!` in `lib.rs`:

```rust
commands::import::import_video,
```

- [ ] **Step 3: Verify compiles**

```bash
cd client/src-tauri
cargo build
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src-tauri/src/
git commit -m "feat(rust): add import_video command (orchestrates download/extract/transcribe)"
```

---

## Phase 6: TS Pure Functions (LLM helpers)

### Task 6.1: SRT parser (TS)

**Files:**
- Create: `client/src/llm/parseSrt.ts`
- Test: `client/src/llm/parseSrt.test.ts`

- [ ] **Step 1: Write the failing test**

Write `client/src/llm/parseSrt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseSrt } from "./parseSrt";

describe("parseSrt", () => {
  it("parses single cue", () => {
    const cues = parseSrt("1\n00:00:01,000 --> 00:00:03,500\nHello world\n");
    expect(cues).toEqual([
      { index: 1, time: 1.0, endTime: 3.5, text: "Hello world" },
    ]);
  });

  it("parses multiple cues with multi-line text", () => {
    const cues = parseSrt(
      "1\n00:00:01,000 --> 00:00:03,500\nFirst\n\n2\n00:00:04,200 --> 00:00:06,800\nLine A\nLine B\n"
    );
    expect(cues).toHaveLength(2);
    expect(cues[1].text).toBe("Line A Line B");
  });

  it("supports hour timecodes", () => {
    const cues = parseSrt("1\n01:02:03,456 --> 01:02:05,000\nLater\n");
    expect(cues[0].time).toBeCloseTo(3723.456, 3);
  });

  it("handles CRLF line endings", () => {
    const cues = parseSrt("1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n");
    expect(cues[0].text).toBe("Hi");
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
cd client
pnpm test parseSrt
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Write `client/src/llm/parseSrt.ts`:

```ts
import type { SrtCue } from "./types";

export function parseSrt(content: string): SrtCue[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n").filter((b) => b.trim().length > 0);
  const cues: SrtCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) continue;
    const index = parseInt(lines[0].trim(), 10);
    if (isNaN(index)) continue;
    const tc = parseTimecodeLine(lines[1]);
    if (!tc) continue;
    const text = lines.slice(2).join(" ").trim();
    cues.push({ index, time: tc.time, endTime: tc.endTime, text });
  }

  return cues;
}

function parseTimecodeLine(line: string): { time: number; endTime: number } | null {
  const parts = line.split("-->");
  if (parts.length !== 2) return null;
  const time = parseTimecode(parts[0].trim());
  const endTime = parseTimecode(parts[1].trim());
  if (time === null || endTime === null) return null;
  return { time, endTime };
}

function parseTimecode(t: string): number | null {
  const normalized = t.replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length !== 3) return null;
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2]);
  if ([h, m, s].some(isNaN)) return null;
  return h * 3600 + m * 60 + s;
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
pnpm test parseSrt
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/llm/parseSrt.ts client/src/llm/parseSrt.test.ts
git commit -m "feat(client): add TS SRT parser"
```

### Task 6.2: Subtitle batching

**Files:**
- Create: `client/src/llm/batchSubtitles.ts`
- Test: `client/src/llm/batchSubtitles.test.ts`

- [ ] **Step 1: Write the failing test**

Write `client/src/llm/batchSubtitles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { batchSubtitles } from "./batchSubtitles";
import type { SrtCue } from "./types";

function makeCues(n: number): SrtCue[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    time: i * 2,
    endTime: i * 2 + 1.8,
    text: `Cue ${i + 1}`,
  }));
}

describe("batchSubtitles", () => {
  it("returns single batch when under limit", () => {
    const batches = batchSubtitles(makeCues(30), 50);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(30);
  });

  it("splits into multiple batches at boundary", () => {
    const batches = batchSubtitles(makeCues(120), 50);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(50);
    expect(batches[1]).toHaveLength(50);
    expect(batches[2]).toHaveLength(20);
  });

  it("handles empty input", () => {
    expect(batchSubtitles([], 50)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd client
pnpm test batchSubtitles
```

- [ ] **Step 3: Implement**

Write `client/src/llm/batchSubtitles.ts`:

```ts
import type { SrtCue } from "./types";

export function batchSubtitles(cues: SrtCue[], batchSize: number): SrtCue[][] {
  const batches: SrtCue[][] = [];
  for (let i = 0; i < cues.length; i += batchSize) {
    batches.push(cues.slice(i, i + batchSize));
  }
  return batches;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm test batchSubtitles
```

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/llm/batchSubtitles.ts client/src/llm/batchSubtitles.test.ts
git commit -m "feat(client): add subtitle batching helper"
```

### Task 6.3: Streaming JSON line parser

**Files:**
- Create: `client/src/llm/streamingJson.ts`
- Test: `client/src/llm/streamingJson.test.ts`

> **Goal:** When the LLM streams a JSON document like `{"subtitles": [{"time":0,...},{"time":1,...}]}`, we want to extract individual subtitle objects as they arrive so the UI can render incrementally. We accomplish this by asking the model to output **JSON Lines** — one JSON object per line — and parsing line-by-line.

- [ ] **Step 1: Write the failing test**

Write `client/src/llm/streamingJson.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { JsonLineParser } from "./streamingJson";

describe("JsonLineParser", () => {
  it("emits objects as complete lines arrive", () => {
    const parser = new JsonLineParser();
    const out: unknown[] = [];
    parser.feed('{"a": 1}\n{"b":', (obj) => out.push(obj));
    expect(out).toEqual([{ a: 1 }]);
    parser.feed(' 2}\n', (obj) => out.push(obj));
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("ignores blank lines", () => {
    const parser = new JsonLineParser();
    const out: unknown[] = [];
    parser.feed('\n{"a":1}\n\n{"b":2}\n', (obj) => out.push(obj));
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("flush emits any pending complete object on its own line", () => {
    const parser = new JsonLineParser();
    const out: unknown[] = [];
    parser.feed('{"x":42}', (obj) => out.push(obj));
    expect(out).toEqual([]);
    parser.flush((obj) => out.push(obj));
    expect(out).toEqual([{ x: 42 }]);
  });

  it("skips invalid JSON lines silently", () => {
    const parser = new JsonLineParser();
    const out: unknown[] = [];
    parser.feed('not json\n{"ok":true}\n', (obj) => out.push(obj));
    expect(out).toEqual([{ ok: true }]);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd client
pnpm test streamingJson
```

- [ ] **Step 3: Implement**

Write `client/src/llm/streamingJson.ts`:

```ts
export class JsonLineParser {
  private buffer = "";

  feed(chunk: string, onObject: (obj: unknown) => void): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.tryParse(line, onObject);
    }
  }

  flush(onObject: (obj: unknown) => void): void {
    const remaining = this.buffer.trim();
    this.buffer = "";
    if (remaining) this.tryParse(remaining, onObject);
  }

  private tryParse(line: string, onObject: (obj: unknown) => void): void {
    if (!line) return;
    try {
      onObject(JSON.parse(line));
    } catch {
      // Silently skip — will be common with prose/markdown wrappers from some models.
    }
  }
}
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm test streamingJson
```

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/llm/streamingJson.ts client/src/llm/streamingJson.test.ts
git commit -m "feat(client): add streaming JSON-lines parser for incremental LLM rendering"
```

### Task 6.4: Time formatting util

**Files:**
- Create: `client/src/utils/time.ts`
- Test: `client/src/utils/time.test.ts`

- [ ] **Step 1: Test**

Write `client/src/utils/time.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatTime } from "./time";

describe("formatTime", () => {
  it("formats seconds to mm:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(125.7)).toBe("2:05");
  });

  it("includes hours when >=3600", () => {
    expect(formatTime(3661)).toBe("1:01:01");
  });
});
```

- [ ] **Step 2: Implement**

Write `client/src/utils/time.ts`:

```ts
export function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
```

- [ ] **Step 3: Run + commit**

```bash
cd client
pnpm test time
```

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/utils/
git commit -m "feat(client): add formatTime util"
```

---

## Phase 7: LLM Layer

### Task 7.1: Prompt definitions

**Files:**
- Create: `client/src/llm/prompts.ts`

> Reference: rules from `.claude/skills/analyze-subtitles/SKILL.md`. Bake all "踩过的坑" rules into the prompt.

- [ ] **Step 1: Write prompt module**

Write `client/src/llm/prompts.ts`:

```ts
import type { SrtCue, Scene, Country } from "./types";

export const SYSTEM_PROMPT = `You are an EngHub English-learning content analyst.

EngHub is a Chinese-language English-learning app for university students preparing to study abroad. Your job: take English subtitle cues from a real-life scenario video and produce structured analysis the app uses for learning.

OUTPUT FORMAT — REQUIRED
- Output ONLY JSON Lines (one JSON object per line, no markdown, no code fences, no prose).
- One line = one analyzed subtitle cue, in the order received.
- After ALL subtitle cues, emit a single trailing line containing a "summary" object with keyPhrases, roleSetup, complications, maxRounds, commonErrors, culturalNotes, sceneContext.

PER-CUE OBJECT SCHEMA
{
  "type": "cue",
  "index": number,                          // matches the input cue index
  "time": number,
  "endTime": number,
  "text": string,                           // EXACT input text, verbatim (preserve typos)
  "translation": string,                    // natural fluent Chinese, NOT word-for-word
  "isKeyPoint": boolean,                    // true if this cue contains an important expression worth learning
  "highlightWords": string[],               // 0-2 phrases. MUST be EXACT substrings of "text" (case-sensitive). Empty if isKeyPoint=false.
  "keyNotes": { [phrase: string]: string }, // 40-120 char Chinese explanation per highlightWord
  "highlightTranslations": { [phrase: string]: string } // each value MUST be EXACT substring of "translation"
}

SUMMARY OBJECT SCHEMA (last line only)
{
  "type": "summary",
  "sceneContext": string,                   // brief description for AI roleplay
  "keyPhrases": [{ "expression": string, "meaningZh": string, "usage": string,
                    "register": "formal"|"casual"|"professional",
                    "speakerRole": "learner"|"passive"|"both",
                    "minDifficulty": "EASY"|"MEDIUM"|"HARD" }],
  "roleSetup": { "name": string, "identity": string, "personality": string,
                  "accent": "American"|"American Female"|"British"|"British Female"|
                            "Australian"|"Australian Female"|"Canadian"|"Canadian Female" },
  "complications": { "medium": string[], "hard": string[] },
  "maxRounds": { "easy": 4, "medium": 6, "hard": 10 },
  "commonErrors": string[],
  "culturalNotes": string,
  "country": "US"|"UK"|"AU"|"CA"
}

CRITICAL RULES (these have caused bugs in the past — follow them strictly):

1. highlightWords MUST be exact substrings of the cue's "text", character-for-character. If the original text has a typo like "teddy beir", use "teddy beir" — DO NOT correct it to "teddy bear".

2. highlightTranslations VALUES MUST be exact substrings of "translation". Do NOT use "和……结合" or "以……闻名" — these are templates with ellipses, NOT substrings of any real translation.

3. keyNotes values: 40-120 Chinese characters each. Aim for 60-80. Explain meaning + usage context, not just translation.

4. Each cue: AT MOST 2 highlightWords. Quality over quantity.

5. isKeyPoint=true ratio: target 30-50% of cues. Greetings, fillers, "yes/no/thank you" are NOT key points.

6. NEVER use raw double quotes inside JSON string values. For Chinese quoted text use 「」 not "". For English quoted text use single quotes or rephrase.

7. Translations are conversational, fluent Chinese — translate filler words too ("Uh..." → "呃...").

8. Each highlightWord must be a substring of THE SAME CUE'S text. Don't span across cues.

9. Output one JSON object per line. No multi-line objects. No leading/trailing whitespace beyond the newline separator.
`;

export function buildUserPrompt(cues: SrtCue[], scene: Scene, country: Country): string {
  const cuesJson = cues
    .map((c) => `${c.index}\t${c.time.toFixed(2)}\t${c.endTime.toFixed(2)}\t${JSON.stringify(c.text)}`)
    .join("\n");
  return `Scene: ${scene}
Target country: ${country}

Subtitle cues (tab-separated: index<TAB>start<TAB>end<TAB>JSON-encoded text):
${cuesJson}

Produce one JSON-line per cue in order, then one summary line at the end. Output JSON only.`;
}

export function buildContinuationPrompt(cues: SrtCue[], scene: Scene, country: Country, isLastBatch: boolean): string {
  const cuesJson = cues
    .map((c) => `${c.index}\t${c.time.toFixed(2)}\t${c.endTime.toFixed(2)}\t${JSON.stringify(c.text)}`)
    .join("\n");
  const trailer = isLastBatch
    ? "After this final batch, emit the summary line."
    : "Do NOT emit the summary yet — more batches will follow.";
  return `Scene: ${scene}
Target country: ${country}

Continuing analysis. Next batch:
${cuesJson}

${trailer}
One JSON object per line.`;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd client
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/llm/prompts.ts
git commit -m "feat(client): add LLM prompt templates with all analyze-subtitles rules"
```

### Task 7.2: Provider interface + dispatcher

**Files:**
- Create: `client/src/llm/providers/types.ts`
- Create: `client/src/llm/providers/index.ts`

- [ ] **Step 1: Write provider interface**

Write `client/src/llm/providers/types.ts`:

```ts
import type { Settings } from "../../types/settings";

export interface ProviderRequest {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * A provider streams text chunks. Caller is responsible for parsing JSON-lines.
 */
export interface Provider {
  stream(req: ProviderRequest): AsyncIterable<string>;
}

export type ProviderFactory = (settings: Settings) => Provider;
```

- [ ] **Step 2: Write dispatcher**

Write `client/src/llm/providers/index.ts`:

```ts
import type { Settings } from "../../types/settings";
import type { Provider } from "./types";
import { createOpenAICompatibleProvider } from "./openaiCompatible";
import { createClaudeProvider } from "./claude";
import { createGeminiProvider } from "./gemini";

export function getProvider(settings: Settings): Provider {
  switch (settings.llmProvider) {
    case "openai-compatible":
      return createOpenAICompatibleProvider(settings);
    case "claude":
      return createClaudeProvider(settings);
    case "gemini":
      return createGeminiProvider(settings);
  }
}

export type { Provider } from "./types";
```

- [ ] **Step 3: Commit (will fail typecheck until next tasks add provider files — that's OK; we commit after wiring complete)**

Skip commit until 7.3-7.5 done.

### Task 7.3: OpenAI-compatible provider

**Files:**
- Create: `client/src/llm/providers/openaiCompatible.ts`
- Test: `client/src/llm/providers/openaiCompatible.test.ts`

- [ ] **Step 1: Write the test (mocked fetch)**

Write `client/src/llm/providers/openaiCompatible.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenAICompatibleProvider } from "./openaiCompatible";
import { DEFAULT_SETTINGS } from "../../types/settings";

beforeEach(() => {
  vi.restoreAllMocks();
});

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe("openaiCompatible provider", () => {
  it("yields delta content from SSE stream", async () => {
    const sseLines =
      `data: {"choices":[{"delta":{"content":"hel"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n` +
      `data: [DONE]\n\n`;

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(makeStream([sseLines]), { status: 200 })
    );

    const provider = createOpenAICompatibleProvider({
      ...DEFAULT_SETTINGS,
      openaiCompatible: { baseUrl: "https://x", apiKey: "k", model: "m" },
    });

    const chunks: string[] = [];
    for await (const c of provider.stream({ systemPrompt: "s", userPrompt: "u" })) {
      chunks.push(c);
    }
    expect(chunks.join("")).toBe("hello");
  });

  it("throws on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 401 }));
    const provider = createOpenAICompatibleProvider({
      ...DEFAULT_SETTINGS,
      openaiCompatible: { baseUrl: "https://x", apiKey: "k", model: "m" },
    });
    await expect(async () => {
      for await (const _ of provider.stream({ systemPrompt: "s", userPrompt: "u" })) {
        // consume
      }
    }).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Implement**

Write `client/src/llm/providers/openaiCompatible.ts`:

```ts
import type { Provider, ProviderRequest } from "./types";
import type { Settings } from "../../types/settings";

export function createOpenAICompatibleProvider(settings: Settings): Provider {
  const cfg = settings.openaiCompatible;

  return {
    async *stream(req: ProviderRequest): AsyncIterable<string> {
      const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          stream: true,
          messages: [
            { role: "system", content: req.systemPrompt },
            { role: "user", content: req.userPrompt },
          ],
        }),
      });

      if (!resp.ok) {
        throw new Error(`OpenAI-compatible API ${resp.status}: ${await resp.text()}`);
      }
      if (!resp.body) {
        throw new Error("response body missing");
      }

      yield* parseSSEStream(resp.body);
    },
  };
}

async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd: number;
    while ((lineEnd = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") yield delta;
      } catch {
        // skip malformed lines
      }
    }
  }
}
```

- [ ] **Step 3: Run test**

```bash
cd client
pnpm test openaiCompatible
```

Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/llm/providers/openaiCompatible.ts client/src/llm/providers/openaiCompatible.test.ts
git commit -m "feat(client): add OpenAI-compatible provider with SSE streaming"
```

### Task 7.4: Claude provider

**Files:**
- Create: `client/src/llm/providers/claude.ts`
- Test: `client/src/llm/providers/claude.test.ts`

- [ ] **Step 1: Write test**

Write `client/src/llm/providers/claude.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClaudeProvider } from "./claude";
import { DEFAULT_SETTINGS } from "../../types/settings";

beforeEach(() => vi.restoreAllMocks());

function makeStream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(encoder.encode(ch)); c.close(); },
  });
}

describe("claude provider", () => {
  it("yields text deltas from event stream", async () => {
    const sse =
      `event: content_block_delta\n` +
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}\n\n` +
      `event: content_block_delta\n` +
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n` +
      `event: message_stop\n` +
      `data: {"type":"message_stop"}\n\n`;

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(makeStream([sse]), { status: 200 }));
    const p = createClaudeProvider({ ...DEFAULT_SETTINGS, claude: { apiKey: "k", model: "m" } });
    let acc = "";
    for await (const c of p.stream({ systemPrompt: "s", userPrompt: "u" })) acc += c;
    expect(acc).toBe("hello");
  });
});
```

- [ ] **Step 2: Implement**

Write `client/src/llm/providers/claude.ts`:

```ts
import type { Provider, ProviderRequest } from "./types";
import type { Settings } from "../../types/settings";

export function createClaudeProvider(settings: Settings): Provider {
  const cfg = settings.claude;
  return {
    async *stream(req: ProviderRequest): AsyncIterable<string> {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 8192,
          stream: true,
          system: req.systemPrompt,
          messages: [{ role: "user", content: req.userPrompt }],
        }),
      });

      if (!resp.ok) throw new Error(`Claude API ${resp.status}: ${await resp.text()}`);
      if (!resp.body) throw new Error("response body missing");
      yield* parseClaudeStream(resp.body);
    },
  };
}

async function* parseClaudeStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd: number;
    while ((lineEnd = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      try {
        const obj = JSON.parse(payload);
        if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
          yield obj.delta.text as string;
        }
        if (obj.type === "message_stop") return;
      } catch { /* skip */ }
    }
  }
}
```

- [ ] **Step 3: Run test + commit**

```bash
cd client
pnpm test claude
```

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/llm/providers/claude.ts client/src/llm/providers/claude.test.ts
git commit -m "feat(client): add Claude provider"
```

### Task 7.5: Gemini provider

**Files:**
- Create: `client/src/llm/providers/gemini.ts`
- Test: `client/src/llm/providers/gemini.test.ts`

- [ ] **Step 1: Write test**

Write `client/src/llm/providers/gemini.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGeminiProvider } from "./gemini";
import { DEFAULT_SETTINGS } from "../../types/settings";

beforeEach(() => vi.restoreAllMocks());

function makeStream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(encoder.encode(ch)); c.close(); },
  });
}

describe("gemini provider", () => {
  it("yields text from streamGenerateContent SSE", async () => {
    const body =
      `data: {"candidates":[{"content":{"parts":[{"text":"hel"}]}}]}\n\n` +
      `data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(makeStream([body]), { status: 200 }));
    const p = createGeminiProvider({ ...DEFAULT_SETTINGS, gemini: { apiKey: "k", model: "gemini-2.5-pro" } });
    let acc = "";
    for await (const c of p.stream({ systemPrompt: "s", userPrompt: "u" })) acc += c;
    expect(acc).toBe("hello");
  });
});
```

- [ ] **Step 2: Implement**

Write `client/src/llm/providers/gemini.ts`:

```ts
import type { Provider, ProviderRequest } from "./types";
import type { Settings } from "../../types/settings";

export function createGeminiProvider(settings: Settings): Provider {
  const cfg = settings.gemini;
  return {
    async *stream(req: ProviderRequest): AsyncIterable<string> {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent` +
        `?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`;

      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: req.userPrompt }] }],
        }),
      });
      if (!resp.ok) throw new Error(`Gemini API ${resp.status}: ${await resp.text()}`);
      if (!resp.body) throw new Error("response body missing");
      yield* parseGeminiStream(resp.body);
    },
  };
}

async function* parseGeminiStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineEnd: number;
    while ((lineEnd = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      try {
        const obj = JSON.parse(payload);
        const text = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text === "string") yield text;
      } catch { /* skip */ }
    }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
cd client
pnpm test gemini
```

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/llm/providers/gemini.ts client/src/llm/providers/gemini.test.ts
git commit -m "feat(client): add Gemini provider"
```

### Task 7.6: Wire provider dispatcher commit

**Files:**
- Modify: (none, just commit the index.ts written in 7.2)

- [ ] **Step 1: Verify everything typechecks**

```bash
cd client
pnpm typecheck
pnpm test
```

Expected: typecheck clean; all provider tests PASS.

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/llm/providers/index.ts client/src/llm/providers/types.ts
git commit -m "feat(client): add provider dispatcher and shared interface"
```

### Task 7.7: Analysis orchestrator

**Files:**
- Create: `client/src/llm/analyze.ts`
- Test: `client/src/llm/analyze.test.ts`

- [ ] **Step 1: Write the test**

Write `client/src/llm/analyze.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runAnalysis } from "./analyze";
import type { Provider } from "./providers/types";

function fakeProvider(scriptedChunks: string[]): Provider {
  return {
    async *stream() {
      for (const c of scriptedChunks) yield c;
    },
  };
}

describe("runAnalysis", () => {
  it("emits parsed cue objects then summary", async () => {
    const provider = fakeProvider([
      `{"type":"cue","index":1,"time":0,"endTime":1,"text":"Hi","translation":"嗨","isKeyPoint":false,"highlightWords":[],"keyNotes":{},"highlightTranslations":{}}\n`,
      `{"type":"cue","index":2,"time":1,"endTime":2,"text":"Bye","translation":"再见","isKeyPoint":false,"highlightWords":[],"keyNotes":{},"highlightTranslations":{}}\n`,
      `{"type":"summary","sceneContext":"x","keyPhrases":[],"roleSetup":{"name":"A","identity":"B","personality":"c","accent":"American"},"complications":{"medium":[],"hard":[]},"maxRounds":{"easy":4,"medium":6,"hard":10},"commonErrors":[],"culturalNotes":"","country":"US"}\n`,
    ]);

    const cues = [
      { index: 1, time: 0, endTime: 1, text: "Hi" },
      { index: 2, time: 1, endTime: 2, text: "Bye" },
    ];

    const cueOut: number[] = [];
    let summary: unknown = null;
    await runAnalysis({
      provider,
      cues,
      scene: "social",
      country: "US",
      onCue: (c) => cueOut.push(c.index),
      onSummary: (s) => { summary = s; },
      batchSize: 50,
    });

    expect(cueOut).toEqual([1, 2]);
    expect(summary).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement**

Write `client/src/llm/analyze.ts`:

```ts
import type { Provider } from "./providers/types";
import type { Subtitle, SrtCue, Scene, Country, AnalysisResult } from "./types";
import { batchSubtitles } from "./batchSubtitles";
import { JsonLineParser } from "./streamingJson";
import { SYSTEM_PROMPT, buildUserPrompt, buildContinuationPrompt } from "./prompts";

export interface RunAnalysisOptions {
  provider: Provider;
  cues: SrtCue[];
  scene: Scene;
  country: Country;
  onCue: (cue: Subtitle) => void;
  onSummary: (summary: Omit<AnalysisResult, "subtitles">) => void;
  batchSize?: number;
}

export async function runAnalysis(opts: RunAnalysisOptions): Promise<void> {
  const batchSize = opts.batchSize ?? 50;
  const batches = batchSubtitles(opts.cues, batchSize);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const isLast = i === batches.length - 1;
    const userPrompt =
      i === 0
        ? buildUserPrompt(batch, opts.scene, opts.country)
        : buildContinuationPrompt(batch, opts.scene, opts.country, isLast);

    const parser = new JsonLineParser();
    for await (const chunk of opts.provider.stream({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
    })) {
      parser.feed(chunk, (obj) => routeObject(obj, opts));
    }
    parser.flush((obj) => routeObject(obj, opts));
  }
}

function routeObject(obj: unknown, opts: RunAnalysisOptions): void {
  if (!obj || typeof obj !== "object") return;
  const o = obj as Record<string, unknown>;
  if (o.type === "cue") {
    const cue: Subtitle = {
      time: Number(o.time),
      endTime: Number(o.endTime),
      text: String(o.text),
      translation: String(o.translation),
      isKeyPoint: Boolean(o.isKeyPoint),
      highlightWords: Array.isArray(o.highlightWords) ? (o.highlightWords as string[]) : [],
      keyNotes: (o.keyNotes as Record<string, string>) ?? {},
      highlightTranslations: (o.highlightTranslations as Record<string, string>) ?? {},
    };
    opts.onCue(cue);
  } else if (o.type === "summary") {
    // Strip the "type" field
    const { type: _drop, ...rest } = o;
    opts.onSummary(rest as Omit<AnalysisResult, "subtitles">);
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
cd client
pnpm test analyze
```

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/llm/analyze.ts client/src/llm/analyze.test.ts
git commit -m "feat(client): add analysis orchestrator (batches + streams cues + emits summary)"
```

---

## Phase 8: State + Tauri Hooks

### Task 8.1: Settings store

**Files:**
- Create: `client/src/store/settings.ts`

- [ ] **Step 1: Write store**

Write `client/src/store/settings.ts`:

```ts
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  save: (s: Settings) => Promise<void>;
}

export const useSettings = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  async load() {
    const raw = await invoke<Settings | null>("get_settings");
    set({ settings: raw ?? DEFAULT_SETTINGS, loaded: true });
  },
  async save(s) {
    await invoke("save_settings", { settings: s });
    set({ settings: s });
  },
}));
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/store/settings.ts
git commit -m "feat(client): add settings zustand store"
```

### Task 8.2: Library store

**Files:**
- Create: `client/src/store/library.ts`

- [ ] **Step 1: Write store**

Write `client/src/store/library.ts`:

```ts
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Library, LibraryEntry, LibraryStatus } from "../types/library";

interface LibraryState {
  library: Library;
  loaded: boolean;
  reload: () => Promise<void>;
  setStatus: (id: string, status: LibraryStatus, error?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  library: { videos: [] },
  loaded: false,
  async reload() {
    const lib = await invoke<Library>("library_list");
    set({ library: lib, loaded: true });
  },
  async setStatus(id, status, error) {
    await invoke("library_set_status", { id, status, error: error ?? null });
    await get().reload();
  },
  async remove(id) {
    await invoke("library_delete", { id });
    await get().reload();
  },
}));

export type { LibraryEntry, Library, LibraryStatus };
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/store/library.ts
git commit -m "feat(client): add library zustand store"
```

### Task 8.3: Analysis store (per-video runtime state)

**Files:**
- Create: `client/src/store/analysis.ts`

- [ ] **Step 1: Write store**

Write `client/src/store/analysis.ts`:

```ts
import { create } from "zustand";
import type { Subtitle, AnalysisResult } from "../llm/types";

export type AnalysisPhase = "idle" | "downloading" | "extracting" | "transcribing" | "analyzing" | "complete" | "error";

interface AnalysisState {
  videoId: string | null;
  phase: AnalysisPhase;
  progressPercent: number;
  subtitles: Subtitle[];
  summary: Omit<AnalysisResult, "subtitles"> | null;
  errorMessage: string | null;

  startFor: (videoId: string) => void;
  setPhase: (phase: AnalysisPhase, percent?: number) => void;
  appendSubtitle: (s: Subtitle) => void;
  setSubtitles: (s: Subtitle[]) => void;
  setSummary: (s: Omit<AnalysisResult, "subtitles">) => void;
  setError: (msg: string) => void;
  reset: () => void;
}

export const useAnalysis = create<AnalysisState>((set) => ({
  videoId: null,
  phase: "idle",
  progressPercent: 0,
  subtitles: [],
  summary: null,
  errorMessage: null,

  startFor: (id) => set({ videoId: id, phase: "downloading", progressPercent: 0, subtitles: [], summary: null, errorMessage: null }),
  setPhase: (phase, percent) => set((s) => ({ phase, progressPercent: percent ?? s.progressPercent })),
  appendSubtitle: (s) => set((st) => ({ subtitles: [...st.subtitles, s] })),
  setSubtitles: (s) => set({ subtitles: s }),
  setSummary: (s) => set({ summary: s }),
  setError: (msg) => set({ phase: "error", errorMessage: msg }),
  reset: () => set({ videoId: null, phase: "idle", progressPercent: 0, subtitles: [], summary: null, errorMessage: null }),
}));
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/store/analysis.ts
git commit -m "feat(client): add per-video analysis runtime state store"
```

### Task 8.4: Tauri event hook

**Files:**
- Create: `client/src/hooks/useTauriEvent.ts`

- [ ] **Step 1: Write hook**

Write `client/src/hooks/useTauriEvent.ts`:

```ts
import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export function useTauriEvent<T>(eventName: string, handler: (payload: T) => void): void {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<T>(eventName, (e) => handler(e.payload)).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [eventName, handler]);
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/hooks/useTauriEvent.ts
git commit -m "feat(client): add useTauriEvent hook"
```

### Task 8.5: Video sync hook

**Files:**
- Create: `client/src/hooks/useVideoSync.ts`

- [ ] **Step 1: Write hook**

Write `client/src/hooks/useVideoSync.ts`:

```ts
import { useEffect, useState, type RefObject } from "react";

/**
 * Returns the currently-playing subtitle index based on video.currentTime.
 */
export function useVideoSync(
  videoRef: RefObject<HTMLVideoElement | null>,
  cues: { time: number; endTime: number }[]
): number {
  const [currentIdx, setCurrentIdx] = useState(-1);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    let raf: number;
    const loop = () => {
      const t = v.currentTime;
      const idx = cues.findIndex((c) => t >= c.time && t < c.endTime);
      setCurrentIdx(idx);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, cues]);

  return currentIdx;
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/hooks/useVideoSync.ts
git commit -m "feat(client): add useVideoSync hook for current-cue tracking"
```

---

## Phase 9: UI Components

### Task 9.1: HighlightWord component

**Files:**
- Create: `client/src/components/HighlightWord.tsx`

- [ ] **Step 1: Write component**

Write `client/src/components/HighlightWord.tsx`:

```tsx
import { useState } from "react";

interface Props {
  word: string;
  note?: string;
}

export function HighlightWord({ word, note }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <span
        className="bg-amber-300 text-black px-0.5 rounded cursor-help font-medium"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
      >
        {word}
      </span>
      {open && note && (
        <span className="absolute left-0 top-full mt-1 z-10 bg-zinc-900 text-zinc-100 border border-zinc-700 rounded px-2 py-1 text-xs whitespace-normal w-64 shadow-lg">
          {note}
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/components/HighlightWord.tsx
git commit -m "feat(client): add HighlightWord component with hover note"
```

### Task 9.2: SubtitleList component

**Files:**
- Create: `client/src/components/SubtitleList.tsx`

- [ ] **Step 1: Write component**

Write `client/src/components/SubtitleList.tsx`:

```tsx
import { useEffect, useRef, type ReactNode } from "react";
import type { Subtitle } from "../llm/types";
import { HighlightWord } from "./HighlightWord";
import { formatTime } from "../utils/time";

interface Props {
  subtitles: Subtitle[];
  currentIdx: number;
  onJump: (timeSec: number) => void;
}

export function SubtitleList({ subtitles, currentIdx, onJump }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (currentIdx < 0) return;
    const el = listRef.current?.querySelector(`[data-idx="${currentIdx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentIdx]);

  return (
    <div ref={listRef} className="overflow-y-auto h-full">
      {subtitles.map((s, i) => (
        <div
          key={i}
          data-idx={i}
          onClick={() => onJump(s.time)}
          className={
            "px-3 py-2 border-b border-zinc-800 cursor-pointer hover:bg-zinc-800/50 " +
            (i === currentIdx ? "bg-blue-500/10 border-l-2 border-l-blue-400 pl-[10px]" : "")
          }
        >
          <div className="text-zinc-500 text-[10px]">
            {formatTime(s.time)} → {formatTime(s.endTime)}
          </div>
          <div className="text-sm leading-relaxed text-zinc-100">
            {renderTextWithHighlights(s)}
          </div>
          <div className="text-zinc-400 text-xs mt-0.5">{s.translation}</div>
        </div>
      ))}
    </div>
  );
}

function renderTextWithHighlights(s: Subtitle): ReactNode {
  if (s.highlightWords.length === 0) return s.text;
  const segments: ReactNode[] = [];
  let cursor = 0;
  // Simple greedy left-to-right highlight insertion.
  const words = [...s.highlightWords].sort((a, b) => s.text.indexOf(a) - s.text.indexOf(b));
  for (const w of words) {
    const idx = s.text.indexOf(w, cursor);
    if (idx === -1) continue;
    if (idx > cursor) segments.push(s.text.slice(cursor, idx));
    segments.push(<HighlightWord key={`${w}-${idx}`} word={w} note={s.keyNotes[w]} />);
    cursor = idx + w.length;
  }
  if (cursor < s.text.length) segments.push(s.text.slice(cursor));
  return segments;
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/components/SubtitleList.tsx
git commit -m "feat(client): add SubtitleList component with auto-scroll + click-to-jump"
```

### Task 9.3: KeyPhraseList component

**Files:**
- Create: `client/src/components/KeyPhraseList.tsx`

- [ ] **Step 1: Write component**

Write `client/src/components/KeyPhraseList.tsx`:

```tsx
import type { KeyPhrase } from "../llm/types";

interface Props {
  phrases: KeyPhrase[];
}

export function KeyPhraseList({ phrases }: Props) {
  if (phrases.length === 0) {
    return <div className="p-4 text-zinc-500 text-sm">分析完成后这里会显示重点短语...</div>;
  }
  return (
    <div className="overflow-y-auto h-full p-3 space-y-3">
      {phrases.map((p, i) => (
        <div key={i} className="border border-zinc-800 rounded-md p-3 bg-zinc-900/40">
          <div className="text-amber-300 font-semibold text-sm">{p.expression}</div>
          <div className="text-zinc-500 text-[10px] mt-1">
            {p.register} · {p.speakerRole} · {p.minDifficulty}
          </div>
          <div className="text-zinc-100 text-xs mt-1.5">{p.meaningZh}</div>
          <div className="text-zinc-400 text-xs mt-1 italic">{p.usage}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/components/KeyPhraseList.tsx
git commit -m "feat(client): add KeyPhraseList component"
```

### Task 9.4: RoleSetupCard component

**Files:**
- Create: `client/src/components/RoleSetupCard.tsx`

- [ ] **Step 1: Write component**

Write `client/src/components/RoleSetupCard.tsx`:

```tsx
import type { RoleSetup } from "../llm/types";

interface Props {
  role: RoleSetup | null;
  sceneContext: string;
}

export function RoleSetupCard({ role, sceneContext }: Props) {
  if (!role) {
    return <div className="p-4 text-zinc-500 text-sm">分析完成后这里会显示角色信息...</div>;
  }
  return (
    <div className="p-4 space-y-4">
      <section>
        <div className="text-zinc-500 text-[10px] uppercase tracking-wide">场景</div>
        <div className="text-zinc-200 text-sm leading-relaxed mt-1">{sceneContext}</div>
      </section>
      <section className="border border-zinc-800 rounded-md p-3 bg-zinc-900/40">
        <div className="text-amber-300 font-semibold">{role.name}</div>
        <div className="text-zinc-400 text-xs mt-1">{role.identity}</div>
        <div className="text-zinc-500 text-[10px] mt-2">性格</div>
        <div className="text-zinc-200 text-xs">{role.personality}</div>
        <div className="text-zinc-500 text-[10px] mt-2">口音</div>
        <div className="text-zinc-200 text-xs">{role.accent}</div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/components/RoleSetupCard.tsx
git commit -m "feat(client): add RoleSetupCard component"
```

### Task 9.5: VideoPlayer component

**Files:**
- Create: `client/src/components/VideoPlayer.tsx`

- [ ] **Step 1: Write component**

Write `client/src/components/VideoPlayer.tsx`:

```tsx
import { forwardRef, useState } from "react";
import { formatTime } from "../utils/time";

interface Props {
  src: string;
}

export const VideoPlayer = forwardRef<HTMLVideoElement, Props>(({ src }, ref) => {
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  function togglePlay() {
    if (!ref || typeof ref === "function") return;
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }

  function seek(t: number) {
    if (!ref || typeof ref === "function") return;
    if (ref.current) ref.current.currentTime = t;
  }

  return (
    <div className="flex flex-col bg-black h-full">
      <video
        ref={ref}
        src={src}
        className="flex-1 w-full bg-black"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="flex items-center gap-3 px-3 py-2 bg-zinc-950 border-t border-zinc-800">
        <button
          onClick={togglePlay}
          className="w-7 h-7 rounded-full bg-blue-500 text-black text-xs flex items-center justify-center"
        >
          {playing ? "⏸" : "▶"}
        </button>
        <span className="text-zinc-500 text-[10px] w-10">{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={currentTime}
          onChange={(e) => seek(parseFloat(e.target.value))}
          className="flex-1 accent-blue-400"
        />
        <span className="text-zinc-500 text-[10px] w-10 text-right">{formatTime(duration)}</span>
      </div>
    </div>
  );
});

VideoPlayer.displayName = "VideoPlayer";
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/components/VideoPlayer.tsx
git commit -m "feat(client): add VideoPlayer component (HTML video + custom controls)"
```

### Task 9.6: ProgressBanner component

**Files:**
- Create: `client/src/components/ProgressBanner.tsx`

- [ ] **Step 1: Write component**

Write `client/src/components/ProgressBanner.tsx`:

```tsx
import { useAnalysis } from "../store/analysis";

const PHASE_LABELS: Record<string, string> = {
  downloading: "下载视频",
  extracting: "抽取音频",
  transcribing: "本地转录",
  analyzing: "AI 分析字幕",
  complete: "完成",
  error: "失败",
};

export function ProgressBanner() {
  const { phase, progressPercent, errorMessage, subtitles } = useAnalysis();
  if (phase === "idle" || phase === "complete") return null;

  return (
    <div
      className={
        "px-4 py-2 text-sm flex items-center gap-3 " +
        (phase === "error" ? "bg-red-900/40 text-red-200" : "bg-blue-900/40 text-blue-100")
      }
    >
      <div className="flex-1">
        {PHASE_LABELS[phase] ?? phase}
        {phase === "analyzing" && ` (${subtitles.length} 行已生成)`}
        {errorMessage && ` — ${errorMessage}`}
      </div>
      {phase !== "error" && phase !== "analyzing" && (
        <div className="w-32 h-1.5 bg-zinc-700 rounded overflow-hidden">
          <div className="h-full bg-blue-400" style={{ width: `${progressPercent}%` }} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/components/ProgressBanner.tsx
git commit -m "feat(client): add ProgressBanner component"
```

### Task 9.7: ImportModal component

**Files:**
- Create: `client/src/components/ImportModal.tsx`

- [ ] **Step 1: Write component**

Write `client/src/components/ImportModal.tsx`:

```tsx
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../store/settings";
import { useLibrary } from "../store/library";
import { useAnalysis } from "../store/analysis";
import { SCENE_LABELS, type Scene, type Country } from "../llm/types";

interface Props {
  onClose: () => void;
}

export function ImportModal({ onClose }: Props) {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const { reload } = useLibrary();
  const { startFor } = useAnalysis();

  const [tab, setTab] = useState<"local" | "url">("url");
  const [urlValue, setUrlValue] = useState("");
  const [filePath, setFilePath] = useState("");
  const [scene, setScene] = useState<Scene>(settings.defaultScene);
  const [country, setCountry] = useState<Country>(settings.defaultCountry);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickFile() {
    const result = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "mkv", "mov", "webm", "avi"] }],
    });
    if (typeof result === "string") setFilePath(result);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const sourceKind = tab;
      const sourceValue = tab === "url" ? urlValue : filePath;
      if (!sourceValue) throw new Error(tab === "url" ? "请输入 URL" : "请选择文件");

      // Fire-and-forget: import_video runs the full pipeline; UI listens for progress events.
      onClose();
      // Navigate immediately to a placeholder ID; we update once import returns the real id.
      // Alternative: await up to videoId resolution. We await for simplicity.
      const result = await invoke<{ videoId: string; srtPath: string; durationSec: number }>(
        "import_video",
        {
          req: {
            sourceKind,
            sourceValue,
            scene,
            country,
            whisperModel: settings.whisperModel,
          },
        }
      );
      startFor(result.videoId);
      await reload();
      navigate(`/player/${result.videoId}?srt=${encodeURIComponent(result.srtPath)}`);
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 w-[480px] max-w-full">
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">导入视频</h2>

        <div className="flex gap-2 mb-3">
          {(["url", "local"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                "px-3 py-1 text-sm rounded " +
                (tab === t ? "bg-blue-500 text-black" : "bg-zinc-800 text-zinc-300")
              }
            >
              {t === "url" ? "粘贴 URL" : "本地文件"}
            </button>
          ))}
        </div>

        {tab === "url" ? (
          <input
            type="text"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            className="w-full px-3 py-2 bg-zinc-800 text-zinc-100 rounded text-sm border border-zinc-700"
          />
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={filePath}
              readOnly
              placeholder="未选择文件"
              className="flex-1 px-3 py-2 bg-zinc-800 text-zinc-300 rounded text-sm border border-zinc-700"
            />
            <button onClick={pickFile} className="px-3 py-2 bg-zinc-700 text-zinc-100 rounded text-sm">
              选择...
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 mt-4">
          <label className="text-sm text-zinc-300">
            场景
            <select
              value={scene}
              onChange={(e) => setScene(e.target.value as Scene)}
              className="w-full mt-1 px-2 py-1.5 bg-zinc-800 text-zinc-100 rounded border border-zinc-700"
            >
              {Object.entries(SCENE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </label>
          <label className="text-sm text-zinc-300">
            国家
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value as Country)}
              className="w-full mt-1 px-2 py-1.5 bg-zinc-800 text-zinc-100 rounded border border-zinc-700"
            >
              {(["US", "UK", "AU", "CA"] as const).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>

        {error && <div className="mt-3 text-sm text-red-400">{error}</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-300">取消</button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-4 py-1.5 bg-blue-500 text-black text-sm rounded font-medium disabled:opacity-50"
          >
            {submitting ? "处理中..." : "开始解析"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/components/ImportModal.tsx
git commit -m "feat(client): add ImportModal component"
```

---

## Phase 10: Pages + Routing

### Task 10.1: Library page

**Files:**
- Create: `client/src/pages/Library.tsx`

- [ ] **Step 1: Write page**

Write `client/src/pages/Library.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useLibrary } from "../store/library";
import { ImportModal } from "../components/ImportModal";
import { SCENE_LABELS } from "../llm/types";
import { formatTime } from "../utils/time";

export function Library() {
  const { library, reload } = useLibrary();
  const [showImport, setShowImport] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => { reload(); }, [reload]);

  const visible = library.videos.filter((v) =>
    v.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800">
        <h1 className="text-lg font-semibold flex-1">Library</h1>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索..."
          className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm w-64"
        />
        <button
          onClick={() => setShowImport(true)}
          className="px-3 py-1.5 bg-blue-500 text-black text-sm rounded font-medium"
        >
          + Import
        </button>
        <Link to="/settings" className="px-2 py-1.5 text-zinc-300 hover:text-zinc-100">⚙</Link>
      </header>

      {visible.length === 0 ? (
        <div className="text-center text-zinc-500 mt-32 text-sm">
          还没有视频。点击右上角 [+ Import] 导入第一个视频。
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-6">
          {visible.map((v) => (
            <Link
              key={v.id}
              to={`/player/${v.id}`}
              className="bg-zinc-900 border border-zinc-800 rounded-md overflow-hidden hover:border-zinc-600"
            >
              <div className="aspect-video bg-zinc-800 relative">
                {v.thumbnailPath && (
                  <img src={convertFileSrc(v.thumbnailPath)} className="w-full h-full object-cover" />
                )}
                {v.status === "analyzing" && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-blue-300 text-xs">
                    解析中...
                  </div>
                )}
                {v.status === "failed" && (
                  <div className="absolute top-2 right-2 bg-red-500 text-white text-xs rounded-full w-6 h-6 flex items-center justify-center">!</div>
                )}
              </div>
              <div className="p-3">
                <div className="text-sm font-medium truncate">{v.title}</div>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-500">
                  <span className="bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded">
                    {SCENE_LABELS[v.scene as keyof typeof SCENE_LABELS] ?? v.scene}
                  </span>
                  {v.durationSec > 0 && <span>{formatTime(v.durationSec)}</span>}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/pages/Library.tsx
git commit -m "feat(client): add Library page"
```

### Task 10.2: Settings page

**Files:**
- Create: `client/src/pages/Settings.tsx`

- [ ] **Step 1: Write page**

Write `client/src/pages/Settings.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../store/settings";
import { listen } from "@tauri-apps/api/event";
import type { Settings, WhisperModelSize, LlmProvider } from "../types/settings";
import { SCENE_LABELS, type Scene, type Country } from "../llm/types";

const WHISPER_SIZES: WhisperModelSize[] = ["tiny", "base", "small", "medium", "large-v3"];

export function Settings() {
  const { settings, load, save } = useSettings();
  const [draft, setDraft] = useState<Settings>(settings);
  const [modelDownloaded, setModelDownloaded] = useState<Record<string, boolean>>({});
  const [downloading, setDownloading] = useState<WhisperModelSize | null>(null);
  const [downloadPct, setDownloadPct] = useState(0);
  const [testStatus, setTestStatus] = useState<string | null>(null);

  useEffect(() => { load(); }, [load]);
  useEffect(() => setDraft(settings), [settings]);

  useEffect(() => {
    Promise.all(
      WHISPER_SIZES.map(async (s) => [s, await invoke<boolean>("whisper_model_status", { size: s })] as const)
    ).then((results) => {
      const map: Record<string, boolean> = {};
      for (const [s, ok] of results) map[s] = ok;
      setModelDownloaded(map);
    });
  }, [downloading]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ stage: string; progress?: number }>("pipeline-event", (e) => {
      if (e.payload.stage === "ModelDownload" && typeof e.payload.progress === "number") {
        setDownloadPct(e.payload.progress);
      }
    }).then((u) => { unlisten = u; });
    return () => unlisten?.();
  }, []);

  async function downloadModel(size: WhisperModelSize) {
    setDownloading(size);
    setDownloadPct(0);
    try {
      await invoke("whisper_model_download", { size });
    } finally {
      setDownloading(null);
    }
  }

  async function testConnection() {
    setTestStatus("测试中...");
    try {
      // Send 1-token request to verify provider works
      const { getProvider } = await import("../llm/providers");
      const p = getProvider(draft);
      let ok = false;
      for await (const _ of p.stream({ systemPrompt: "Reply with 'ok'.", userPrompt: "ok" })) { ok = true; break; }
      setTestStatus(ok ? "✓ 连接成功" : "✗ 无响应");
    } catch (e) {
      setTestStatus(`✗ ${e}`);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800">
        <Link to="/" className="text-zinc-400 hover:text-zinc-100">◀ Back</Link>
        <h1 className="text-lg font-semibold">设置</h1>
      </header>

      <div className="max-w-2xl mx-auto p-6 space-y-8">
        <section>
          <h2 className="font-semibold mb-3">LLM Provider</h2>
          <select
            value={draft.llmProvider}
            onChange={(e) => setDraft({ ...draft, llmProvider: e.target.value as LlmProvider })}
            className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm"
          >
            <option value="openai-compatible">OpenAI 兼容协议</option>
            <option value="claude">Claude (Anthropic)</option>
            <option value="gemini">Gemini (Google)</option>
          </select>

          {draft.llmProvider === "openai-compatible" && (
            <div className="grid grid-cols-1 gap-3 mt-3">
              <Field label="Base URL" value={draft.openaiCompatible.baseUrl}
                onChange={(v) => setDraft({ ...draft, openaiCompatible: { ...draft.openaiCompatible, baseUrl: v } })} />
              <Field label="API Key" type="password" value={draft.openaiCompatible.apiKey}
                onChange={(v) => setDraft({ ...draft, openaiCompatible: { ...draft.openaiCompatible, apiKey: v } })} />
              <Field label="Model" value={draft.openaiCompatible.model}
                onChange={(v) => setDraft({ ...draft, openaiCompatible: { ...draft.openaiCompatible, model: v } })} />
            </div>
          )}

          {draft.llmProvider === "claude" && (
            <div className="grid grid-cols-1 gap-3 mt-3">
              <Field label="API Key" type="password" value={draft.claude.apiKey}
                onChange={(v) => setDraft({ ...draft, claude: { ...draft.claude, apiKey: v } })} />
              <Field label="Model" value={draft.claude.model}
                onChange={(v) => setDraft({ ...draft, claude: { ...draft.claude, model: v } })} />
            </div>
          )}

          {draft.llmProvider === "gemini" && (
            <div className="grid grid-cols-1 gap-3 mt-3">
              <Field label="API Key" type="password" value={draft.gemini.apiKey}
                onChange={(v) => setDraft({ ...draft, gemini: { ...draft.gemini, apiKey: v } })} />
              <Field label="Model" value={draft.gemini.model}
                onChange={(v) => setDraft({ ...draft, gemini: { ...draft.gemini, model: v } })} />
            </div>
          )}

          <div className="flex items-center gap-3 mt-3">
            <button onClick={testConnection} className="px-3 py-1.5 bg-zinc-800 text-sm rounded">
              测试连接
            </button>
            {testStatus && <span className="text-sm text-zinc-400">{testStatus}</span>}
          </div>
        </section>

        <section>
          <h2 className="font-semibold mb-3">Whisper 模型</h2>
          <select
            value={draft.whisperModel}
            onChange={(e) => setDraft({ ...draft, whisperModel: e.target.value as WhisperModelSize })}
            className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm"
          >
            {WHISPER_SIZES.map((s) => (
              <option key={s} value={s}>{s} {modelDownloaded[s] ? "(已下载)" : "(未下载)"}</option>
            ))}
          </select>
          {!modelDownloaded[draft.whisperModel] && (
            <button
              onClick={() => downloadModel(draft.whisperModel)}
              disabled={downloading !== null}
              className="ml-3 px-3 py-1.5 bg-blue-500 text-black text-sm rounded disabled:opacity-50"
            >
              {downloading === draft.whisperModel ? `下载中 ${downloadPct}%` : "下载"}
            </button>
          )}
        </section>

        <section>
          <h2 className="font-semibold mb-3">默认值</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              默认场景
              <select
                value={draft.defaultScene}
                onChange={(e) => setDraft({ ...draft, defaultScene: e.target.value as Scene })}
                className="w-full mt-1 px-2 py-1.5 bg-zinc-900 border border-zinc-800 rounded"
              >
                {Object.entries(SCENE_LABELS).map(([k, l]) => (
                  <option key={k} value={k}>{l}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              默认国家
              <select
                value={draft.defaultCountry}
                onChange={(e) => setDraft({ ...draft, defaultCountry: e.target.value as Country })}
                className="w-full mt-1 px-2 py-1.5 bg-zinc-900 border border-zinc-800 rounded"
              >
                {(["US", "UK", "AU", "CA"] as const).map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          </div>
        </section>

        <button
          onClick={() => save(draft)}
          className="px-4 py-2 bg-blue-500 text-black font-medium rounded text-sm"
        >
          保存设置
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label className="text-sm text-zinc-300">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full mt-1 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100"
      />
    </label>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/pages/Settings.tsx
git commit -m "feat(client): add Settings page"
```

### Task 10.3: Player page

**Files:**
- Create: `client/src/pages/Player.tsx`

- [ ] **Step 1: Write page**

Write `client/src/pages/Player.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useAnalysis } from "../store/analysis";
import { useSettings } from "../store/settings";
import { useLibrary } from "../store/library";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useVideoSync } from "../hooks/useVideoSync";
import { VideoPlayer } from "../components/VideoPlayer";
import { SubtitleList } from "../components/SubtitleList";
import { KeyPhraseList } from "../components/KeyPhraseList";
import { RoleSetupCard } from "../components/RoleSetupCard";
import { ProgressBanner } from "../components/ProgressBanner";
import { parseSrt } from "../llm/parseSrt";
import { runAnalysis } from "../llm/analyze";
import { getProvider } from "../llm/providers";
import { SCENE_LABELS } from "../llm/types";
import type { AnalysisResult, Subtitle } from "../llm/types";

type Tab = "subtitles" | "keyPhrases" | "role";

export function Player() {
  const { videoId } = useParams<{ videoId: string }>();
  const [searchParams] = useSearchParams();
  const srtPathFromImport = searchParams.get("srt");

  const { settings } = useSettings();
  const { library, reload } = useLibrary();
  const analysis = useAnalysis();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [tab, setTab] = useState<Tab>("subtitles");
  const [videoSrc, setVideoSrc] = useState<string>("");

  const entry = library.videos.find((v) => v.id === videoId);

  // Listen for pipeline progress events
  useTauriEvent<{ stage: string; video_id?: string; percent?: number }>("pipeline-event", (e) => {
    if (e.video_id !== videoId) return;
    if (e.stage === "Downloading") analysis.setPhase("downloading", e.percent);
    if (e.stage === "ExtractingAudio") analysis.setPhase("extracting", 100);
    if (e.stage === "Transcribing") analysis.setPhase("transcribing", e.percent);
  });

  // Resolve video source path
  useEffect(() => {
    if (!videoId) return;
    invoke<string>("video_source_path", { videoId }).then((p) => setVideoSrc(convertFileSrc(p)));
  }, [videoId]);

  // Initial load: try cached analysis first; if missing and we have an SRT path, run analysis
  useEffect(() => {
    if (!videoId) return;
    (async () => {
      const cached = await invoke<AnalysisResult | null>("load_analysis", { videoId });
      if (cached) {
        analysis.setSubtitles(cached.subtitles);
        const { subtitles: _drop, ...summary } = cached;
        analysis.setSummary(summary);
        analysis.setPhase("complete");
        return;
      }

      // No cached analysis — must run it
      analysis.startFor(videoId);
      let srt: string | null = null;
      if (srtPathFromImport) {
        srt = await invoke<string | null>("load_transcript", { videoId });
      } else {
        srt = await invoke<string | null>("load_transcript", { videoId });
      }
      if (!srt) {
        analysis.setError("找不到 transcript.srt — 请重新解析");
        return;
      }

      analysis.setPhase("analyzing");
      const cues = parseSrt(srt);
      const provider = getProvider(settings);
      try {
        await runAnalysis({
          provider,
          cues,
          scene: (entry?.scene ?? "social") as never,
          country: (entry?.country ?? "US") as never,
          onCue: (c: Subtitle) => analysis.appendSubtitle(c),
          onSummary: (s) => analysis.setSummary(s),
        });
        // Persist
        const finalAnalysis: AnalysisResult = {
          ...(useAnalysis.getState().summary as Omit<AnalysisResult, "subtitles">),
          subtitles: useAnalysis.getState().subtitles,
        };
        await invoke("save_analysis", { videoId, analysis: finalAnalysis });
        await invoke("library_set_status", { id: videoId, status: "ready", error: null });
        analysis.setPhase("complete");
        await reload();
      } catch (e) {
        analysis.setError(String(e));
        await invoke("library_set_status", { id: videoId, status: "failed", error: String(e) });
        await reload();
      }
    })();
    // We only want this to run on first videoId mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const currentIdx = useVideoSync(videoRef, analysis.subtitles);

  function jump(t: number) {
    if (videoRef.current) videoRef.current.currentTime = t;
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800">
        <Link to="/" className="text-zinc-400 hover:text-zinc-100 text-sm">◀ Back</Link>
        <div className="flex-1 truncate text-sm">{entry?.title ?? videoId}</div>
        {entry?.scene && (
          <span className="bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded text-xs">
            {SCENE_LABELS[entry.scene as keyof typeof SCENE_LABELS] ?? entry.scene}
          </span>
        )}
      </header>

      <ProgressBanner />

      <div className="flex-1 flex min-h-0">
        <div className="w-[58%] border-r border-zinc-800">
          {videoSrc && <VideoPlayer ref={videoRef} src={videoSrc} />}
        </div>
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex border-b border-zinc-800 text-sm">
            {(["subtitles", "keyPhrases", "role"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  "px-4 py-2 " +
                  (tab === t ? "text-blue-400 border-b-2 border-blue-400" : "text-zinc-400")
                }
              >
                {t === "subtitles" ? "字幕" : t === "keyPhrases" ? `重点短语 (${analysis.summary?.keyPhrases.length ?? 0})` : "角色信息"}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0">
            {tab === "subtitles" && (
              <SubtitleList subtitles={analysis.subtitles} currentIdx={currentIdx} onJump={jump} />
            )}
            {tab === "keyPhrases" && <KeyPhraseList phrases={analysis.summary?.keyPhrases ?? []} />}
            {tab === "role" && (
              <RoleSetupCard
                role={analysis.summary?.roleSetup ?? null}
                sceneContext={analysis.summary?.sceneContext ?? ""}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/pages/Player.tsx
git commit -m "feat(client): add Player page (left video + right tabs + analysis orchestration)"
```

### Task 10.4: App routing

**Files:**
- Modify: `client/src/App.tsx`
- Modify: `client/src/main.tsx`

- [ ] **Step 1: Replace App.tsx**

Replace `client/src/App.tsx` entirely:

```tsx
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Library } from "./pages/Library";
import { Player } from "./pages/Player";
import { Settings } from "./pages/Settings";
import "./App.css";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/library" replace />} />
        <Route path="/library" element={<Library />} />
        <Route path="/player/:videoId" element={<Player />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
```

- [ ] **Step 2: Verify main.tsx imports App**

`client/src/main.tsx` should already render `<App />`. If not, ensure:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 3: Verify everything builds**

```bash
cd client
pnpm typecheck
pnpm tauri dev
```

Expected: window opens at the Library page (empty state).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/App.tsx client/src/main.tsx
git commit -m "feat(client): wire up router (Library / Player / Settings)"
```

---

## Phase 11: First-Run Flow

### Task 11.1: First-run guard

**Files:**
- Modify: `client/src/pages/Library.tsx`
- Create: `client/src/components/FirstRunGate.tsx`

- [ ] **Step 1: Write FirstRunGate**

Write `client/src/components/FirstRunGate.tsx`:

```tsx
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../store/settings";

interface Props {
  children: ReactNode;
}

export function FirstRunGate({ children }: Props) {
  const { settings, load, loaded } = useSettings();
  const [modelOk, setModelOk] = useState<boolean | null>(null);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!loaded) return;
    invoke<boolean>("whisper_model_status", { size: settings.whisperModel }).then(setModelOk);
  }, [loaded, settings.whisperModel]);

  if (!loaded || modelOk === null) {
    return <div className="min-h-screen bg-zinc-950 text-zinc-500 flex items-center justify-center text-sm">加载中...</div>;
  }

  const hasLlmKey = (() => {
    if (settings.llmProvider === "openai-compatible") return Boolean(settings.openaiCompatible.apiKey);
    if (settings.llmProvider === "claude") return Boolean(settings.claude.apiKey);
    return Boolean(settings.gemini.apiKey);
  })();

  if (!hasLlmKey || !modelOk) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-2xl font-semibold">欢迎使用 Get_Video</h1>
          <p className="text-zinc-400 text-sm">
            首次启动需要：
            {!hasLlmKey && <span className="block">· 配置 LLM API Key</span>}
            {!modelOk && <span className="block">· 下载 Whisper 模型 ({settings.whisperModel})</span>}
          </p>
          <Link to="/settings" className="inline-block px-5 py-2 bg-blue-500 text-black font-medium rounded">
            进入设置
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
```

- [ ] **Step 2: Wrap Library in App.tsx**

Edit `client/src/App.tsx`, change Library route:

```tsx
import { FirstRunGate } from "./components/FirstRunGate";

// ...
<Route path="/library" element={<FirstRunGate><Library /></FirstRunGate>} />
```

- [ ] **Step 3: Verify**

```bash
cd client
pnpm tauri dev
```

Expected: with no settings, you see the welcome screen with a "进入设置" button.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/renjx/Desktop/Get_Video"
git add client/src/components/FirstRunGate.tsx client/src/App.tsx
git commit -m "feat(client): add first-run gate (require LLM key + Whisper model)"
```

---

## Phase 12: Manual Smoke Test

### Task 12.1: End-to-end smoke test (local file)

> Manual verification — no commit required at the end unless you change code.

- [ ] **Step 1: Start app**

```bash
cd client
pnpm tauri dev
```

- [ ] **Step 2: Configure settings**

1. Click "进入设置" on welcome screen
2. Choose "OpenAI 兼容协议", paste a working DeepSeek (or other) key + model
3. Click "测试连接" — expect "✓ 连接成功"
4. Pick Whisper model "small", click "下载" — expect progress bar
5. After download completes, click "保存设置"

- [ ] **Step 3: Import a local video**

1. Navigate back to Library
2. Click "+ Import"
3. Switch to "本地文件" tab, pick a short MP4 (5-30 sec) from disk
4. Choose scene "社交日常", country "US"
5. Click "开始解析"

- [ ] **Step 4: Verify**

Expected behavior:
- ProgressBanner shows: "抽取音频" → "本地转录" (with %) → "AI 分析字幕"
- Page navigates to /player/{id}
- Subtitles appear one row at a time as LLM streams
- Once complete, click a subtitle row → video jumps; play video → current row highlights and scrolls
- Switch to "重点短语" tab → see keyPhrase cards
- Switch to "角色信息" tab → see role card
- Reload app: Library shows the video; clicking opens Player with cached analysis (no re-analysis)

If any step fails, debug and re-run before continuing.

### Task 12.2: End-to-end smoke test (URL)

- [ ] **Step 1: Start app, click Import**

- [ ] **Step 2: Switch to URL tab, paste a short YouTube URL** (a public video < 1 min, e.g. `https://www.youtube.com/watch?v=dQw4w9WgXcQ` if it's region-OK; otherwise pick another short video)

- [ ] **Step 3: Click "开始解析"**

Expected: ProgressBanner shows "下载视频 X%" → continues through extract → transcribe → analyze. Final state same as 12.1.

- [ ] **Step 4: If it fails on download, check yt-dlp.exe + cookies**

If you see auth errors, the bundled yt-dlp may need cookies. Document this limitation in `client/src-tauri/binaries/README.md` for future improvement.

---

## Self-Review Checklist (verify before handoff)

- [x] Spec §1 scope → Tasks 0.1-0.3 (project setup), Tasks 4.x (binaries), Task 11.1 (first-run)
- [x] Spec §2 architecture (Rust subprocess + JS LLM) → Tasks 5.x (Rust pipeline), Tasks 7.x (TS LLM)
- [x] Spec §3 data model → Tasks 1.x (TS types), 2.x (Rust core), 3.x (Rust commands)
- [x] Spec §4.1 import flow → Task 5.6 (import_video) + Task 10.3 (Player orchestrates LLM)
- [x] Spec §4.2 playback → Task 9.5 (VideoPlayer) + Task 8.5 (useVideoSync)
- [x] Spec §4.3 first-run → Task 11.1 (FirstRunGate)
- [x] Spec §5 UI structure → Tasks 10.1-10.4
- [x] Spec §6 modules → All file paths in tasks match the spec's module tree
- [x] Spec §7 errors → Task 5.6 (status: failed in library), Task 10.3 (catch + display)
- [x] Spec §8 testing → Pure-function unit tests in Tasks 2.x, 6.x, 7.3-7.7; UI manual in Task 12

No placeholders found. Type names consistent across phases (Subtitle, AnalysisResult, LibraryEntry use the same shape in TS and Rust serialization).

---

## Plan Complete

Plan saved to `docs/superpowers/plans/2026-04-26-video-analysis-client.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
