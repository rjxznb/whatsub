# Eversay Studio

桌面端英文字幕学习播放器：导入视频（本地文件 / YouTube 链接）→ 本地 whisper.cpp 转录 → AI 翻译 + 重点短语标注 → 双语播放 + 词汇本。

## 下载

最新版本 **v0.1.2**（2026-04-30）：

| 平台 | 下载 | 说明 |
|------|------|------|
| Windows 10/11 x64 | [Eversay.Studio_0.1.2_x64_en-US.msi](https://github.com/rjxznb/Get_Video-releases/releases/download/v0.1.2/Eversay.Studio_0.1.2_x64_en-US.msi) | 双击安装，自动更新 |
| macOS Apple Silicon | [Eversay.Studio_0.1.2_aarch64.dmg](https://github.com/rjxznb/Get_Video-releases/releases/download/v0.1.2/Eversay.Studio_0.1.2_aarch64.dmg) | 见下方首次打开教程 |
| Intel Mac | — | 暂不支持 |

## 主要功能

- **本地转录**：whisper.cpp 在本机跑，不上传音频；自动检测 GPU
  - Windows：Vulkan 后端，NVIDIA / AMD / Intel 显卡都加速
  - Mac：Metal 后端，Apple Silicon 原生
  - 无 GPU 自动 fallback CPU
- **任意 LLM**：DeepSeek / OpenAI / Kimi / Claude / Gemini / 智谱 / Qwen / SiliconFlow / Ollama，10 个预设 + 自定义
- **YouTube 导入**：内置 yt-dlp，支持 cookies.txt 绕年龄/地区限制
- **字幕导出**：英文 / 中文 / 双语 SRT
- **词汇本**：⭐ 收藏重点短语，跨视频汇总，CSV 导出，深链跳回原片对应字幕段
- **断点续传**：长视频可暂停/继续 AI 解析，状态自动落盘

## 首次打开（macOS）

App 没有走 Apple 公证（需要每年 $99 开发者账号），系统会弹「已损坏」拒绝打开。绕过一次即可：

**方法 1（推荐，5 步）：**

1. 双击 .app → 弹「已损坏」错误，点「废纸篓」按钮 → **不要点废纸篓**，直接关闭
2. 打开「系统设置」→「隐私与安全性」
3. 滚动到底部，找到「Eversay 已被阻止使用…」
4. 点击「仍要打开」
5. 输入开机密码确认 → 重新双击 .app 即可

**方法 2（终端，一行命令）：**

```bash
xattr -cr "/Applications/Eversay Studio.app"
```

之后双击直接打开。

> 后续每次打开正常，不会再报错。

## 首次配置

打开 app 后引导页要求填两项：

1. **LLM API key**：选一个厂商（DeepSeek 最便宜，¥0.001/千 tokens 起），按预设填 base URL + key
2. **Whisper 模型**：默认 `small`（466 MB）够用；视频清晰度高 / 想要更准 → 选 `medium` 或 `large-v3`

填完保存，回到 Library 页点 **+ Import** 导入第一个视频。

## 从源码构建

详见 [client/CLAUDE.md](./CLAUDE.md) — 包含 Rust 模块表、构建命令、whisper.cpp 编译指南、release 流程。

## 反馈

GitHub Issues: <https://github.com/rjxznb/Get_Video-releases/issues>
