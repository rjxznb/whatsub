# Long-video VAD transcription — design

**Date:** 2026-06-30
**Scope:** `client/` (Tauri desktop app — Rust whisper pipeline + bundling/CI)
**Status:** approved, pending implementation plan

## Problem

whisper.cpp transcription of long, music/sound-heavy, sparse-dialogue media (e.g.
a 46-minute feature film) produces two failures, confirmed on a real user import
even with the `large-v3` model:

1. **Timestamp drift** — segments pin to whisper's 30-second processing-window
   boundaries (observed cues spaced exactly 30s apart with identical fractional
   parts), drifting ~20s out of sync with the audio by mid-film.
2. **Hallucination / repetition loops** — on non-speech stretches whisper emits
   repeated caption-style annotations (observed 9× consecutive `[phone rings]`,
   7× `[door closes]`).

Short videos transcribe accurately; the failures are specific to long media. The
audio extraction is correct (16 kHz mono, full duration, no offset), and `-mc 0`
is already set — so the root cause is whisper's intrinsic long-form behavior, not
a whatsub bug.

## Goal

For long videos only, enable whisper.cpp's **native VAD** (`--vad`), which detects
speech regions and feeds only those to whisper with their true start times. This
simultaneously:
- skips non-speech → kills the hallucination/repetition loops,
- re-anchors each speech region to real time → bounds the drift,
- cuts at silence → no mid-word boundary artifacts,
in a single whisper-cli invocation.

## Non-goals

- **No user-facing setting / toggle.** VAD is fully automatic and invisible — the
  user never configures it. (Explicit decision: the user doesn't need to know.)
- No VAD parameter-tuning UI (use whisper.cpp defaults).
- No change to short-video behavior (≤ threshold transcribes exactly as today).
- No custom audio chunking/merging — whisper.cpp's `--vad` does the segmentation.

## Key facts (verified)

- The shipped `whisper-cli` (v1.8.4) supports VAD natively: `--vad`,
  `--vad-model FNAME`, plus `-vt/-vsd/-vmsd/-vp/-vo` tuning flags (defaults are
  sensible). Confirmed via `whisper-cli --help` on the actual binary.
- `transcribe()` lives in `pipeline/whisper.rs` and is the single chokepoint for
  ALL transcription paths (normal import `commands/import.rs:233`, retranscribe
  `commands/import.rs:360`). Gating here covers foreground, background, AI-agent,
  and retranscribe with no per-caller change.
- `pipeline/ffmpeg.rs::probe_duration_secs(app, path) -> f64` already exists
  (best-effort, returns 0.0 on failure) — use it to get audio duration.
- whatsub currently bundles **no** models (all whisper models are downloaded
  in-app). The VAD model will be the first bundled model → a new bundling +
  CI step is required. `pipeline/whisper.rs::bundled_model_path` already resolves
  bundled resources via `app.path().resource_dir().join("models")`, a pattern to
  mirror.
- The whisper invocation in `run_whisper_once` already passes `-mc 0`; VAD
  composes with it.

## Design

### Unit 1 — VAD model delivery (bundled)

Ship the Silero VAD ggml model (~2 MB; the whisper.cpp v1.8.4-compatible Silero
model — exact filename/URL pinned in the implementation plan) inside the
installer:

- Place the file where the other sidecars/resources live so `resource_dir()`
  resolves it at runtime. Add a `vad_model_path(app) -> Option<PathBuf>` in
  `pipeline/whisper.rs` returning `Some` only when the bundled file exists
  (mirrors `bundled_model_path`).
- `src-tauri/binaries/` is gitignored, so dev machines need the file locally
  (document it in `binaries/README.md` + `setup-windows.ps1`, like the other
  sidecars).
- Add a step to `.github/workflows/release.yml` (both Win + Mac jobs) to fetch
  the VAD model and stage it into the bundle, and declare it in
  `tauri.conf.json` `bundle.resources` (+ the macOS overlay if needed).

### Unit 2 — Gating logic (`pipeline/whisper.rs`)

- A **pure** function (unit-tested, no I/O):
  ```
  const VAD_MIN_DURATION_SECS: f64 = 1200.0; // 20 min
  fn should_use_vad(duration_secs: f64, vad_model_present: bool) -> bool {
      vad_model_present && duration_secs > VAD_MIN_DURATION_SECS
  }
  ```
- In `transcribe()` (once, before the stall-retry loop): probe duration via
  `probe_duration_secs(app, audio_path)`, resolve `vad_model_path(app)`, compute
  `should_use_vad(...)`. Thread the decision (and the model path) into
  `run_whisper_once`.
- In `run_whisper_once`, when VAD is on, append `--vad`, `--vad-model <path>` to
  the whisper-cli args (keep existing `-mc 0`, `-l en`, `-osrt`, etc.). Use
  whisper.cpp default VAD parameters.

### Unit 3 — Graceful fallback + visibility

- If the VAD model is absent (`vad_model_path` is `None` — e.g. a dev build that
  didn't stage it) or duration probing returns `0.0`, `should_use_vad` is false
  → transcription runs exactly as today. VAD is strictly additive; its absence
  never breaks transcription.
- When VAD is enabled, emit one `PipelineEvent::Log` line (e.g. "长视频已启用 VAD
  智能分段") so it's visible in the log panel — informational only, no action
  required.
- The VAD decision is invariant across the existing whisper stall-retries
  (computed once in `transcribe()`, reused each attempt) — same as the GPU
  device-pinning invariant.

## Data flow

```
import → extract_audio_wav → transcribe(audio_path)
                               ├─ probe_duration_secs(audio_path)
                               ├─ vad_model_path(app)            (bundled resource)
                               ├─ should_use_vad(dur, model?) ── true ──► run_whisper_once(+ --vad --vad-model)
                               └──────────────────────────────── false ─► run_whisper_once(as today)
```

## Testing

- `should_use_vad` pure unit tests: >20min + model present → true; ≤20min → false;
  >20min + model absent → false; duration 0.0 → false.
- `vad_model_path` resolution test (present vs absent) following the existing
  bundled-resource test pattern (temp/injected paths per `paths::*` rules where
  applicable).
- Manual smoke test (the real validation): retranscribe the user's 46-min film
  and confirm (a) the `[phone rings]`/`[door closes]` consecutive-repeat loops are
  gone, and (b) timestamps track the audio (no ~20s drift). Also retranscribe a
  short clip to confirm no behavior change (VAD not engaged).

## Rollout / risk

- Additive: a new bundled model + a gated flag append. No change to short-video
  output, no schema/migration, no UI.
- Main risk is the bundling/CI step (new pattern) — if the model fails to stage,
  graceful fallback means transcription still works (just without VAD on long
  videos). Verify in a real `pnpm tauri build` that the model lands in the bundle
  and `vad_model_path` resolves.
- Installer grows ~2 MB.
- Whisper VAD on a borderline-quiet speaker could theoretically clip very soft
  speech; default threshold (0.5) + speech padding mitigate. Acceptable given the
  alternative (unusable long-video transcripts today). No toggle by decision; the
  20-min gate keeps it off the accurate short-video path.
