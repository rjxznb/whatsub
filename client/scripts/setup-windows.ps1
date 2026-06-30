# whatsub 桌面端 —— Windows 一键开发部署脚本
# ---------------------------------------------------------------------------
# 为什么需要它：`src-tauri/binaries/` 里的 sidecar 二进制（yt-dlp / ffmpeg /
# ffprobe / node / whisper-cli + ggml*.dll）是 .gitignore 掉的，clone 下来是空的，
# 所以新机器不能直接 `pnpm tauri dev`。本脚本补齐它们 + 装依赖。
#
# 用法（两种都行）：
#   A) 已经 clone 了仓库 —— 直接在仓库里跑：
#        powershell -ExecutionPolicy Bypass -File client\scripts\setup-windows.ps1
#   B) 全新机器、还没 clone —— 把本脚本 + whisper-win-bits.zip 拷到一个空文件夹再跑，
#      它会自动 clone：
#        .\setup-windows.ps1 -Dir D:\dev\Get_Video
#
# whisper-win-bits.zip（whisper.dll / whisper-cli / ggml*.dll，自构建、无法自动下载）
# 需放在本脚本同目录；没有的话脚本会提示从源机器拷。
# ---------------------------------------------------------------------------
param(
  # 仓库位置。不传时：若脚本本身在某个已 clone 的仓库里，就用那个仓库；否则
  # 默认 桌面\Get_Video。注意：想在新机器续用同一个 Claude 会话，这个路径要和
  # 源机器完全一致（同用户名、同位置）。
  [string]$Dir
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $Dir) {
  $maybeRepo = (Resolve-Path (Join-Path $PSScriptRoot '..\..') -ErrorAction SilentlyContinue)
  if ($maybeRepo -and (Test-Path (Join-Path $maybeRepo '.git'))) { $Dir = $maybeRepo.Path }
  else { $Dir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Get_Video' }
}

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host "=== 1/5 检查前置工具 ===" -ForegroundColor Cyan
$missing = @()
foreach ($t in @(
  @{cmd='git';   hint='Git: https://git-scm.com/download/win'},
  @{cmd='node';  hint='Node.js LTS: https://nodejs.org (装完重开终端)'},
  @{cmd='pnpm';  hint='pnpm: 运行 `corepack enable` 或 `npm i -g pnpm`'},
  @{cmd='cargo'; hint='Rust: https://rustup.rs (默认 msvc 工具链)'}
)) {
  if (Have $t.cmd) { Write-Host "  [OK] $($t.cmd)" -ForegroundColor Green }
  else { Write-Host "  [缺失] $($t.cmd) —— $($t.hint)" -ForegroundColor Red; $missing += $t.cmd }
}
if (-not (Have 'link') -and -not (Have 'cl')) {
  Write-Host "  [注意] 没检测到 MSVC 链接器。若 `pnpm tauri dev` 报找不到 link.exe，" -ForegroundColor Yellow
  Write-Host "         请装 Visual Studio Build Tools 勾选『使用 C++ 的桌面开发』。" -ForegroundColor Yellow
}
if ($missing.Count) { Write-Host "请先装好缺失工具再重跑本脚本。" -ForegroundColor Red; exit 1 }

Write-Host "=== 2/5 准备仓库 -> $Dir ===" -ForegroundColor Cyan
if (Test-Path (Join-Path $Dir '.git')) {
  Write-Host "  已是 git 仓库，跳过 clone（要更新自己 git pull）。"
} elseif (Test-Path $Dir) {
  throw "目录 $Dir 已存在但不是 git 仓库，请换个 -Dir 或清空它。"
} else {
  git clone https://github.com/rjxznb/whatsub.git $Dir
}
$client = Join-Path $Dir 'client'
$bin = Join-Path $client 'src-tauri\binaries'
New-Item -ItemType Directory -Force -Path $bin | Out-Null

Write-Host "=== 3/5 下载标准 sidecar (yt-dlp / ffmpeg / ffprobe / node) ===" -ForegroundColor Cyan
Write-Host "  (国内可能需科学上网才能下到 github / nodejs；下不动见末尾 B 方案)"
function Fetch($url, $out) {
  if (Test-Path $out) { Write-Host "  已存在 $(Split-Path $out -Leaf)，跳过"; return }
  Write-Host "  下载 $(Split-Path $out -Leaf) ..."
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
}
Fetch 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' (Join-Path $bin 'yt-dlp-x86_64-pc-windows-msvc.exe')
Fetch 'https://nodejs.org/dist/v22.11.0/win-x64/node.exe' (Join-Path $bin 'node-x86_64-pc-windows-msvc.exe')
$ffzip = Join-Path $env:TEMP 'whatsub-ffmpeg.zip'
Fetch 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip' $ffzip
$ffdir = Join-Path $env:TEMP 'whatsub-ffmpeg'
if (Test-Path $ffdir) { Remove-Item $ffdir -Recurse -Force }
Expand-Archive -Path $ffzip -DestinationPath $ffdir -Force
$ffexe = Get-ChildItem $ffdir -Recurse -Filter ffmpeg.exe | Select-Object -First 1
Copy-Item $ffexe.FullName (Join-Path $bin 'ffmpeg-x86_64-pc-windows-msvc.exe') -Force
Copy-Item (Join-Path $ffexe.Directory.FullName 'ffprobe.exe') (Join-Path $bin 'ffprobe-x86_64-pc-windows-msvc.exe') -Force
Write-Host "  ffmpeg / ffprobe / yt-dlp / node 就位" -ForegroundColor Green
$models = Join-Path $client 'src-tauri\models'
New-Item -ItemType Directory -Force -Path $models | Out-Null
Fetch 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' (Join-Path $models 'ggml-silero-v5.1.2.bin')

Write-Host "=== 4/5 解压 whisper 自构建 DLL ===" -ForegroundColor Cyan
$wzip = Join-Path $PSScriptRoot 'whisper-win-bits.zip'
if (Test-Path $wzip) {
  Expand-Archive -Path $wzip -DestinationPath $bin -Force
  Write-Host "  whisper.dll / whisper-cli / ggml*.dll 就位" -ForegroundColor Green
} else {
  Write-Host "  [警告] 没找到 whisper-win-bits.zip（应和本脚本同目录）。" -ForegroundColor Yellow
  Write-Host "         从源机器拷 client\src-tauri\binaries\ 里的 whisper.dll / whisper-cli-*.exe / ggml*.dll 到 $bin 即可。" -ForegroundColor Yellow
}

Write-Host "=== 5/5 pnpm install ===" -ForegroundColor Cyan
Push-Location $client
pnpm install
Pop-Location

Write-Host ""
Write-Host "✅ 完成。开发运行：" -ForegroundColor Green
Write-Host "    cd `"$client`""
Write-Host "    pnpm tauri dev          # 首次 cargo 编译 5-15 分钟"
Write-Host ""
Write-Host "打发布版 exe 还需把源机器的  %USERPROFILE%\.tauri\whatsub.key  拷过来，纯 dev 不需要。" -ForegroundColor DarkGray
Write-Host "B 方案（下载下不动时）：把源机器整个 client\src-tauri\binaries\ 文件夹拷到新机同位置，再只跑第 5 步 pnpm install。" -ForegroundColor DarkGray
