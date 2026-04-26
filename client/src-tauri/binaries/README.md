# Bundled External Binaries

These binaries are bundled into the installer via Tauri's `externalBin` mechanism.
They are NOT checked into git (see `.gitignore`).

## Required files (Windows x64)

### Standalone executables (declared in `tauri.conf.json` `externalBin`)

| File | Source | Version |
|---|---|---|
| `yt-dlp-x86_64-pc-windows-msvc.exe` | https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe | 2026.03.17 |
| `ffmpeg-x86_64-pc-windows-msvc.exe` | https://www.gyan.dev/ffmpeg/builds/ — "full" build (or copy from local `C:\Users\renjx\Desktop\ASR\ffmpeg\bin\ffmpeg.exe`) | 2026-01-12 |
| `whisper-cli-x86_64-pc-windows-msvc.exe` | https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-blas-bin-x64.zip — extract `Release/whisper-cli.exe` | v1.8.4 (BLAS CPU) |

### Whisper DLL dependencies (declared in `tauri.conf.json` `bundle.resources`)

`whisper-cli.exe` depends on 6 DLLs that must be in the same directory at runtime.
Extract them all from `whisper-blas-bin-x64.zip` (`Release/*.dll`):

- `ggml.dll`
- `ggml-base.dll`
- `ggml-blas.dll`
- `ggml-cpu.dll`
- `libopenblas.dll`
- `whisper.dll`

## Acquisition (one-shot, repeatable)

If this directory needs to be repopulated:

```bash
# yt-dlp
curl -L -o "yt-dlp-x86_64-pc-windows-msvc.exe" \
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"

# ffmpeg (or copy from your existing install)
cp "/c/Users/renjx/Desktop/ASR/ffmpeg/bin/ffmpeg.exe" "ffmpeg-x86_64-pc-windows-msvc.exe"

# whisper.cpp (extract whisper-cli + DLLs)
curl -L -o /tmp/whisper.zip \
  "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-blas-bin-x64.zip"
mkdir -p /tmp/whisper-extract
unzip -q /tmp/whisper.zip -d /tmp/whisper-extract
cp /tmp/whisper-extract/Release/whisper-cli.exe whisper-cli-x86_64-pc-windows-msvc.exe
cp /tmp/whisper-extract/Release/{ggml,ggml-base,ggml-blas,ggml-cpu,libopenblas,whisper}.dll .
rm -rf /tmp/whisper.zip /tmp/whisper-extract
```

## Verification

```bash
./yt-dlp-x86_64-pc-windows-msvc.exe --version       # → 2026.03.17
./ffmpeg-x86_64-pc-windows-msvc.exe -version        # → ffmpeg version 2026-...
./whisper-cli-x86_64-pc-windows-msvc.exe --help     # → usage: ...
```

All three should exit 0.

## Why CPU-BLAS instead of CUDA?

Whisper.cpp ships several Windows builds:

- `whisper-bin-x64.zip` (3 MB) — pure CPU, no acceleration
- `whisper-blas-bin-x64.zip` (15 MB) — CPU + OpenBLAS ✅ **chosen**
- `whisper-cublas-11.8.0-bin-x64.zip` (56 MB) — NVIDIA CUDA 11.8
- `whisper-cublas-12.4.0-bin-x64.zip` (435 MB) — NVIDIA CUDA 12.4 (huge — bundles the runtime)

We chose CPU-BLAS for the MVP because:
1. Works on every Windows machine (no GPU/CUDA dependency)
2. Reasonable installer size (~50 MB total bundle increase)
3. small-model transcription on CPU is fast enough for short videos (1-3 min for 10-min input)
4. CUDA builds tie us to specific CUDA runtime versions on the user's machine

If GPU acceleration becomes a priority later, we can ship a CUDA variant as an opt-in alternative.
