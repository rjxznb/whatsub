# Long-video VAD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-enable whisper.cpp native VAD (`--vad`) for videos longer than 20 minutes, fixing timestamp drift + hallucination loops on long media, with zero user-facing configuration.

**Architecture:** A pure gate (`should_use_vad`) + a pure arg-builder (`build_whisper_args`) decide and inject the VAD flags inside `pipeline/whisper.rs::transcribe()` — the single chokepoint for every transcription path. A bundled ~885 KB Silero VAD ggml model is resolved at runtime; if absent, transcription falls back to today's behavior. No settings, no UI.

**Tech Stack:** Rust (Tauri 2 pipeline), whisper-cli v1.8.4 VAD flags, GitHub Actions release workflow, Tauri bundle resources.

## Global Constraints

- VAD model file: `ggml-silero-v5.1.2.bin` (~885 KB).
- VAD model URL: `https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin`.
- Duration threshold: `VAD_MIN_DURATION_SECS: f64 = 1200.0` (20 minutes), a hardcoded constant — NO user setting.
- VAD flags appended to whisper-cli: `--vad`, `--vad-model <path>`. Keep all existing flags (`-m`, `-f`, `-l en`, `-mc 0`, `-osrt`, `-of`, `--print-progress`).
- Gating lives in Rust `transcribe()` — covers foreground import, background, AI-agent, and retranscribe with no per-caller change.
- Graceful fallback: VAD model absent (`vad_model_path` → None) OR duration probe returns `0.0` ⇒ VAD off, transcription runs exactly as today. VAD is strictly additive.
- The VAD decision is computed ONCE in `transcribe()` and reused across whisper stall-retries (invariant, like GPU pinning).
- Bundled model path convention: `resource_dir()/models/<file>` (mirrors `bundled_model_path`).

---

### Task 1: Pure gating + arg-building logic

**Files:**
- Modify: `client/src-tauri/src/pipeline/whisper.rs` (add consts + 2 pure fns + 1 resolver near the other model-path helpers, ~line 60)
- Test: inline `#[cfg(test)] mod tests` in `whisper.rs` (already exists)

**Interfaces:**
- Produces: `const VAD_MIN_DURATION_SECS: f64 = 1200.0;`
- Produces: `fn should_use_vad(duration_secs: f64, vad_model_present: bool) -> bool`
- Produces: `fn build_whisper_args<'a>(model: &'a str, audio: &'a str, out_base: &'a str, vad_model: Option<&'a str>) -> Vec<&'a str>`
- Produces: `fn vad_model_path(app: &AppHandle) -> Option<std::path::PathBuf>` (not unit-tested — needs AppHandle, mirrors `bundled_model_path`)

- [ ] **Step 1: Write the failing tests.** Add to the existing `#[cfg(test)] mod tests` in `whisper.rs`:

```rust
#[test]
fn vad_gate_only_for_long_videos_with_model() {
    assert!(should_use_vad(1201.0, true));       // > 20 min + model present
    assert!(!should_use_vad(1200.0, true));      // exactly 20 min → not greater
    assert!(!should_use_vad(600.0, true));       // short
    assert!(!should_use_vad(3600.0, false));     // long but model missing
    assert!(!should_use_vad(0.0, true));         // probe failed (0.0)
}

#[test]
fn whisper_args_without_vad_have_no_vad_flags() {
    let args = build_whisper_args("m.bin", "a.wav", "out", None);
    assert!(!args.contains(&"--vad"));
    assert!(args.contains(&"-mc") && args.contains(&"0"));
    assert!(args.contains(&"-osrt"));
    // sanity: model + audio threaded through
    assert!(args.contains(&"m.bin") && args.contains(&"a.wav"));
}

#[test]
fn whisper_args_with_vad_append_vad_flags() {
    let args = build_whisper_args("m.bin", "a.wav", "out", Some("vad.bin"));
    assert!(args.contains(&"--vad"));
    let i = args.iter().position(|a| *a == "--vad-model").unwrap();
    assert_eq!(args[i + 1], "vad.bin");
    // existing flags preserved
    assert!(args.contains(&"-mc") && args.contains(&"-osrt"));
}
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `cd client/src-tauri && cargo test vad`
Expected: FAIL — `should_use_vad` / `build_whisper_args` not found.

- [ ] **Step 3: Write the implementation.** Add near the model-path helpers in `whisper.rs` (after `resolve_model_path`, ~line 60):

```rust
/// Minimum audio duration (seconds) above which VAD is auto-enabled.
/// Short videos transcribe accurately without VAD; only long media suffers
/// whisper's drift/hallucination, so we gate on length. Hardcoded — no setting.
const VAD_MIN_DURATION_SECS: f64 = 1200.0; // 20 minutes

/// Bundled Silero VAD model file name (shipped under resource_dir/models/).
const VAD_MODEL_FILE: &str = "ggml-silero-v5.1.2.bin";

/// Pure gate: enable VAD only for long media when the VAD model is available.
fn should_use_vad(duration_secs: f64, vad_model_present: bool) -> bool {
    vad_model_present && duration_secs > VAD_MIN_DURATION_SECS
}

/// Build the whisper-cli argument vector. When `vad_model` is `Some`, append
/// `--vad --vad-model <path>`; otherwise the args are exactly today's set.
fn build_whisper_args<'a>(
    model: &'a str,
    audio: &'a str,
    out_base: &'a str,
    vad_model: Option<&'a str>,
) -> Vec<&'a str> {
    let mut args: Vec<&str> = vec![
        "-m", model,
        "-f", audio,
        "-l", "en",
        "-mc", "0",
        "-osrt",
        "-of", out_base,
        "--print-progress",
    ];
    if let Some(vm) = vad_model {
        args.push("--vad");
        args.push("--vad-model");
        args.push(vm);
    }
    args
}

/// Resolve the bundled VAD model (resource_dir/models/<VAD_MODEL_FILE>).
/// `None` when not present — callers then skip VAD (graceful fallback).
fn vad_model_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let p = app
        .path()
        .resource_dir()
        .ok()?
        .join("models")
        .join(VAD_MODEL_FILE);
    p.exists().then_some(p)
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd client/src-tauri && cargo test vad`
Expected: PASS (3 tests). `cargo build` clean (note: `vad_model_path` will warn `never used` until Task 2 — acceptable mid-task; if the build denies warnings, add `#[allow(dead_code)]` to `vad_model_path` and remove it in Task 2).

- [ ] **Step 5: Commit.**

```bash
git add client/src-tauri/src/pipeline/whisper.rs
git commit -m "feat(whisper): pure VAD gate + arg-builder + bundled-model resolver"
```

---

### Task 2: Wire VAD into transcribe() + run_whisper_once

**Files:**
- Modify: `client/src-tauri/src/pipeline/whisper.rs` — `transcribe()` (~319-387) and `run_whisper_once()` (~394-533)

**Interfaces:**
- Consumes (Task 1): `should_use_vad`, `build_whisper_args`, `vad_model_path`, `VAD_MODEL_FILE`.
- Consumes (existing): `crate::pipeline::ffmpeg::probe_duration_secs(app, path).await -> f64`.
- Changes `run_whisper_once` signature to add a `vad_model: Option<&str>` parameter.

- [ ] **Step 1: Add the duration probe + VAD decision in `transcribe()`.** In `transcribe()`, after `let model = resolve_model_path(...)?;` and the `out_base` line, before the GPU-preference block, insert:

```rust
    // VAD decision — computed once, invariant across stall retries (like GPU pinning).
    let duration_secs = crate::pipeline::ffmpeg::probe_duration_secs(app, audio_path).await;
    let vad_model = vad_model_path(app);
    let use_vad = should_use_vad(duration_secs, vad_model.is_some());
    let vad_arg: Option<String> = if use_vad {
        vad_model.as_ref().map(|p| p.to_string_lossy().to_string())
    } else {
        None
    };
    if use_vad {
        emit(
            app,
            PipelineEvent::Log {
                video_id: video_id.to_string(),
                source: "whatsub".into(),
                line: "长视频已启用 VAD 智能分段（跳过非语音段，提升字幕准确度）".into(),
            },
        );
    }
```

- [ ] **Step 2: Thread `vad_arg` into the retry loop's `run_whisper_once` call.** In `transcribe()`'s `loop { match run_whisper_once(app, &audio_str, &model_str, &out_base, &env, prefer_discrete, pinned, video_id, cancel).await { ... } }`, add `vad_arg.as_deref()` as the new argument:

```rust
        match run_whisper_once(
            app, &audio_str, &model_str, &out_base, &env, prefer_discrete, pinned,
            vad_arg.as_deref(), video_id, cancel,
        )
        .await
```

- [ ] **Step 3: Update `run_whisper_once` signature + use the arg-builder.** Add the param to the signature (after `pinned: Option<u32>`):

```rust
async fn run_whisper_once(
    app: &AppHandle,
    audio_str: &str,
    model_str: &str,
    out_base: &str,
    env: &[(&str, &str)],
    prefer_discrete: bool,
    pinned: Option<u32>,
    vad_model: Option<&str>,
    video_id: &str,
    cancel: Option<&CancellationToken>,
) -> AppResult<()> {
```

Then replace the inline `&[ "-m", model_str, ... "--print-progress" ]` slice passed to `run_sidecar_env` with the builder:

```rust
    let whisper_args = build_whisper_args(model_str, audio_str, out_base, vad_model);
    run_sidecar_env(
        app,
        "whisper-cli",
        &whisper_args,
        env,
        Some(progress_count.clone()),
        move |chunk| {
            // ... unchanged callback body ...
        },
        cancel,
    )
    .await?;
```

(Leave the callback body and everything after `.await?` unchanged.) If Task 1 added `#[allow(dead_code)]` to `vad_model_path`, remove it now.

- [ ] **Step 4: Build + run the suite.**

Run: `cd client/src-tauri && cargo test vad && cargo build`
Expected: 3 VAD tests pass; clean build, no `vad_model_path is never used` warning.

- [ ] **Step 5: Commit.**

```bash
git add client/src-tauri/src/pipeline/whisper.rs
git commit -m "feat(whisper): enable VAD in transcribe() for >20min media (all paths)"
```

---

### Task 3: Bundle the VAD model (config + CI + dev docs)

**Files:**
- Modify: `client/src-tauri/tauri.conf.json` (add `bundle.resources`)
- Modify: `.github/workflows/release.yml` (VAD-model fetch steps — Windows ~after line 303, macOS ~after line 564)
- Modify: `client/src-tauri/binaries/README.md` (document the dev requirement)
- Modify: `client/scripts/setup-windows.ps1` (fetch the VAD model for dev)

> **Why a per-file Windows resource:** macOS already bundles `models/*` (the 147 MB
> base model + the VAD model) via `tauri.macos.conf.json`. The Windows base config
> has no `resources` key (Windows currently bundles no model). Adding `models/*` to
> the Windows base would balloon the installer by 147 MB, so we bundle ONLY the
> 885 KB VAD file there.

- [ ] **Step 1: Declare the VAD model as a bundled resource (Windows base).** In `client/src-tauri/tauri.conf.json`, inside the `"bundle": { ... }` object (e.g. right after the `"externalBin": [...]` array, before `"windows"`), add:

```json
    "resources": [
      "models/ggml-silero-v5.1.2.bin"
    ],
```

(The macOS overlay's `"resources": ["models/*"]` already covers the VAD file on Mac — leave `tauri.macos.conf.json` unchanged.)

- [ ] **Step 2: Add the Windows CI fetch step.** In `.github/workflows/release.yml`, immediately AFTER the `Download bundled whisper model (Windows)` step (ends ~line 303) and BEFORE `Tauri build (NSIS .exe + .sig)`, insert:

```yaml
      - name: Cache bundled VAD model (Windows)
        id: vad-cache-win
        uses: actions/cache@v4
        with:
          path: client/src-tauri/models/ggml-silero-v5.1.2.bin
          key: vad-model-silero-v5.1.2-v1

      - name: Download bundled VAD model (Windows)
        if: steps.vad-cache-win.outputs.cache-hit != 'true'
        run: |
          $url = "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
          Write-Host "Downloading VAD model $url"
          New-Item -ItemType Directory -Force -Path client/src-tauri/models | Out-Null
          Invoke-WebRequest -Uri $url -OutFile client/src-tauri/models/ggml-silero-v5.1.2.bin -UseBasicParsing
          $sz = (Get-Item client/src-tauri/models/ggml-silero-v5.1.2.bin).Length
          Write-Host "Downloaded $sz bytes"
          if ($sz -lt 500KB) { Write-Error "VAD model too small ($sz bytes) — download failed"; exit 1 }
```

- [ ] **Step 3: Add the macOS CI fetch step.** In `release.yml`, immediately AFTER the `Download bundled whisper model (macOS)` step (ends ~line 564) and BEFORE the macOS `Tauri build` step, insert:

```yaml
      - name: Cache bundled VAD model (macOS)
        id: vad-cache-mac
        uses: actions/cache@v4
        with:
          path: client/src-tauri/models/ggml-silero-v5.1.2.bin
          key: vad-model-silero-v5.1.2-v1

      - name: Download bundled VAD model (macOS)
        if: steps.vad-cache-mac.outputs.cache-hit != 'true'
        run: |
          set -euo pipefail
          mkdir -p client/src-tauri/models
          url="https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
          echo "Downloading VAD model $url"
          curl -fL "$url" -o client/src-tauri/models/ggml-silero-v5.1.2.bin
          sz=$(stat -f%z client/src-tauri/models/ggml-silero-v5.1.2.bin)
          echo "Downloaded $sz bytes"
          if [ "$sz" -lt 500000 ]; then echo "VAD model too small ($sz) — download failed"; exit 1; fi
```

- [ ] **Step 4: Document the dev requirement.** Append to `client/src-tauri/binaries/README.md` a short section (the model lives under `src-tauri/models/`, not `binaries/`, but README is where sidecar provisioning is documented):

```markdown
## Bundled VAD model (long-video transcription)

`src-tauri/models/ggml-silero-v5.1.2.bin` (~885 KB) is bundled so whisper.cpp VAD
auto-engages for videos > 20 min. Not in git. For local dev, fetch it once:

```bash
mkdir -p client/src-tauri/models
curl -fL https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin \
  -o client/src-tauri/models/ggml-silero-v5.1.2.bin
```

Absent → VAD silently off (transcription still works; long videos just keep the
old drift). CI fetches it for release builds.
```

- [ ] **Step 5: Fetch the VAD model in the Windows dev setup script.** In `client/scripts/setup-windows.ps1`, in the section that downloads sidecars (the `Fetch ...` calls under "下载标准 sidecar"), add after the existing fetches:

```powershell
$models = Join-Path $client 'src-tauri\models'
New-Item -ItemType Directory -Force -Path $models | Out-Null
Fetch 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' (Join-Path $models 'ggml-silero-v5.1.2.bin')
```

- [ ] **Step 6: Commit.**

```bash
git add client/src-tauri/tauri.conf.json .github/workflows/release.yml client/src-tauri/binaries/README.md client/scripts/setup-windows.ps1
git commit -m "build(vad): bundle ggml-silero-v5.1.2 model (Win resource + CI fetch + dev docs)"
```

- [ ] **Step 7: MANDATORY human verification (cannot be unit-tested).** This task's correctness can only be confirmed by a real build + run, because bundling/resource-resolution and the actual VAD transcription are not exercisable in unit tests:
  1. Fetch the model locally (Step 4 command), then `cd client && pnpm tauri build` (or `pnpm tauri dev`).
  2. Confirm the VAD model lands in the bundle (Win: in the installed app's `resources/models/`; Mac: in `*.app/Contents/Resources/models/`).
  3. Re-transcribe the 46-min film (`...\library\55079a95f5a0` source) via the Player's 重新转录. Confirm the log shows "长视频已启用 VAD 智能分段", the `[phone rings]`/`[door closes]` consecutive-repeat loops are gone, and timestamps track the audio (no ~20s drift).
  4. Re-transcribe a SHORT clip; confirm the VAD log line does NOT appear and output is unchanged.

---

## Final verification

- [ ] `cd client/src-tauri && cargo test` — all green (incl. the 3 VAD tests).
- [ ] `cd client && pnpm typecheck && pnpm test` — unchanged, still green (no TS touched, but confirm nothing regressed).
- [ ] Human real-build smoke test per Task 3 Step 7 (the only validation of actual VAD behavior + bundling).
