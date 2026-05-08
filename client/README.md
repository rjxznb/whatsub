# whatsub

桌面端英文字幕学习播放器：导入视频（本地文件 / YouTube 链接）→ 本地 whisper.cpp 转录 → AI 翻译 + 重点短语标注 → 双语播放 + 词汇本。

## 下载

最新版本 **v0.1.23**（2026-05-07，Win 改 NSIS 安装包 + 主程序更名 whatsub.exe）：

| 平台 | 下载（**国内推荐**）| 下载（GitHub 备用）| 说明 |
|------|---------------------|--------------------|------|
| Windows 10/11 x64 | [whatsub_0.1.23_x64-setup.exe](https://jihulab.com/rjxznb-group/whatsub-release/-/releases/v0.1.23/downloads/whatsub_0.1.23_x64-setup.exe) | [GitHub](https://github.com/rjxznb/whatsub-releases/releases/download/v0.1.23/whatsub_0.1.23_x64-setup.exe) | NSIS 安装包，双击装到当前用户、无需管理员权限。**老版本（v0.1.22 及以前的 .msi 用户）请先在「程序和功能」里卸载老的 whatsub，再装新的 .exe**——两个安装系统的注册表入口不互通 |
| macOS Apple Silicon | [whatsub_0.1.23_aarch64.dmg](https://jihulab.com/rjxznb-group/whatsub-release/-/releases/v0.1.23/downloads/whatsub_0.1.23_aarch64.dmg) | [GitHub](https://github.com/rjxznb/whatsub-releases/releases/download/v0.1.23/whatsub_0.1.23_aarch64.dmg) | 已 Apple Developer ID 签名 + 公证，双击 .dmg → **务必拖进 Applications 文件夹再打开**（直接从下载目录打开会触发 macOS App Translocation，自动更新会写不进去） |
| Intel Mac | — | — | 暂不支持 |

> 国内用户推荐 jihulab 链接（极狐 GitLab，国内直连，无需梯子）；GitHub 链接作为备用。应用内自动更新会优先尝试 jihulab，失败时自动回落到 GitHub。

## 主要功能

- **本地转录**：whisper.cpp 在本机跑，不上传音频；自动检测 GPU
  - Windows：Vulkan 后端，NVIDIA / AMD / Intel 显卡都加速
  - Mac：Metal 后端，Apple Silicon 原生
  - 无 GPU 自动 fallback CPU
- **任意 LLM**：DeepSeek / OpenAI / Kimi / Claude / Gemini / 智谱 / Qwen / SiliconFlow / Ollama，10 个预设 + 自定义
- **YouTube 导入**：内置 yt-dlp，支持 cookies.txt 绕年龄/地区限制；可选画质（480p / 720p / 1080p / 原画）
- **字幕导出**：英文 / 中文 / 双语 SRT，或将带高亮的字幕烧录进视频导出 MP4（可选 高 / 标准 / 流畅 三档画质），也支持都不勾字幕直接流复制原视频
- **词汇本**：⭐ 收藏重点短语，跨视频汇总，CSV 导出，深链跳回原片对应字幕段
- **断点续传**：字幕识别引擎下载、长视频 AI 解析都可暂停/继续，状态自动落盘

## 首次配置

### 0. 激活授权（必需）

打开 app 第一眼会要求输入授权码（`WHATSUB-XXXX-XXXX-XXXX-XXXX`）。授权码在小红书 / 闲鱼店铺购买后通过私信发放，**一份授权码可在 3 台个人设备上同时激活**，永久有效。

> 国内首次激活会联网验证一次（首次 TCP 握手 5-10 秒），**激活后软件完全离线运行**，不再联网。激活时请保持网络畅通。
> 想换电脑？联系客服免费释放设备槽位。

### 1-2. 引导页两步配置

1. **翻译服务**：选一个厂商（DeepSeek 最便宜，¥0.001/千 tokens 起），填 API Key 后点「保存并测试」会自动连通验证
2. **字幕识别引擎**：5 个档位
   - 极速（75 MB）/ 轻量（142 MB）/ **标准（466 MB，推荐）** / 高精度（1.5 GB）/ 顶级（3 GB）
   - 下载到一半可暂停，下次进来从断点继续

填完两步进入 Library 页，点 **+ Import** 导入第一个视频。

## 从源码构建

详见 [client/CLAUDE.md](./CLAUDE.md) — 包含 Rust 模块表、构建命令、whisper.cpp 编译指南、release 流程。

## 反馈

GitHub Issues: <https://github.com/rjxznb/whatsub-releases/issues>
