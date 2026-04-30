# Bundled External Binaries

Bundled into the installer via Tauri's `externalBin` + `bundle.resources` / `bundle.macOS.frameworks`. **Not checked into git** — re-acquire on each dev machine.

## Windows x64 — Vulkan whisper.cpp

| File | Source | Version |
|------|--------|---------|
| `yt-dlp-x86_64-pc-windows-msvc.exe` | https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe | 2026.03.17 |
| `ffmpeg-x86_64-pc-windows-msvc.exe` | https://www.gyan.dev/ffmpeg/builds/ "full" build | recent |
| `whisper-cli-x86_64-pc-windows-msvc.exe` | self-built from whisper.cpp v1.8.4 with `-DGGML_VULKAN=ON` | v1.8.4 (Vulkan + CPU fallback) |

Companion DLLs (declared in `tauri.conf.json` `bundle.resources`):

- `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-vulkan.dll`, `whisper.dll`

### Build whisper-cli locally (one-shot)

Requires VS 2022 + Vulkan SDK 1.4.x (`winget install KhronosGroup.VulkanSDK`).

```bash
git clone --depth 1 --branch v1.8.4 https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -S . -B build -G "Visual Studio 17 2022" -A x64 \
  -DGGML_VULKAN=ON -DBUILD_SHARED_LIBS=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DVulkan_INCLUDE_DIR="C:/VulkanSDK/1.4.341.1/Include" \
  -DVulkan_LIBRARY="C:/VulkanSDK/1.4.341.1/Lib/vulkan-1.lib"
cmake --build build --config Release --target whisper-cli --parallel
# Output in build/bin/Release/ — copy whisper-cli.exe + 5 DLLs into this directory.
```

## macOS arm64 (Apple Silicon) — Metal whisper.cpp

Built by `.github/workflows/build-mac-binaries.yml` on a `macos-14` GitHub Actions runner. Manually triggered when whisper.cpp is upgraded.

| File | Notes |
|------|-------|
| `whisper-cli-aarch64-apple-darwin` | Mach-O, ad-hoc signed |
| `ffmpeg-aarch64-apple-darwin` | static build from osxexperts.net |
| `yt-dlp-aarch64-apple-darwin` | yt-dlp_macos universal binary |
| `libwhisper.1.dylib`, `libggml.0.dylib`, `libggml-base.0.dylib`, `libggml-blas.0.dylib`, `libggml-cpu.0.dylib`, `libggml-metal.0.dylib` | All `install_name_tool`'d to `@loader_path/...`. Metal shader bytecode is **embedded** into `libggml-metal.0.dylib` (whisper.cpp ≥ v1.7 default `GGML_METAL_EMBED_LIBRARY=ON`); no separate `.metallib` file. |

### Refresh from CI

```bash
gh workflow run build-mac-binaries.yml --repo rjxznb/Get_Video
# wait ~1 min
gh run watch <id> --repo rjxznb/Get_Video --exit-status
gh run download <id> --repo rjxznb/Get_Video --name mac-aarch64-binaries --dir client/src-tauri/binaries
# Trim duplicates (keep only `.X.dylib` major-version names — match @rpath):
cd client/src-tauri/binaries
rm libwhisper.1.8.4.dylib libwhisper.dylib libggml*.0.9.8.dylib libggml*.dylib 2>/dev/null
```

## Verification

```bash
./yt-dlp-x86_64-pc-windows-msvc.exe --version
./ffmpeg-x86_64-pc-windows-msvc.exe -version
./whisper-cli-x86_64-pc-windows-msvc.exe -h    # first lines should print "ggml_vulkan: Found N Vulkan devices"
```

Mac equivalents (run on Mac):

```bash
./whisper-cli-aarch64-apple-darwin -h          # first lines: "ggml_metal: ..."
otool -L whisper-cli-aarch64-apple-darwin     # all whisper deps should be @loader_path/... (or @rpath/...)
```

## Why Vulkan / Metal instead of CUDA-only?

| Backend | NVIDIA | AMD | Intel Arc | Intel iGPU | Cost |
|---------|:---:|:---:|:---:|:---:|------|
| Vulkan (Windows) | ✅ ~80% CUDA speed | ✅ | ✅ | ✅ | self-build, +6 MB installer |
| CUDA 11.8 | 🚀 fastest | ❌ | ❌ | ❌ | official prebuilt, +58 MB |
| Metal (Mac) | — | — | — | — / Apple GPU | self-build via CI, embedded |
| CPU + BLAS | ✅ | ✅ | ✅ | ✅ | trivial, slow |

Vulkan is the only **truly cross-vendor** GPU acceleration on Windows. Metal is the only sensible choice on Mac. ggml falls back to CPU automatically when GPU init fails, so a single binary covers the long tail.
