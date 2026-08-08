# whatsub

桌面端英文字幕学习播放器：导入视频（本地文件 / YouTube 链接）→ 本地 whisper.cpp 转录 → AI 翻译 + 重点短语标注 → 双语播放 + 词汇本。

## 下载

最新版本 **v0.1.53**（2026-05-19,准备中阶段拆 5 步 + 排查清单加 yt-dlp 原始错误 + 默认展开日志面板）:

> 不需要总盯版本号 —— 装上之后会自动检测更新,bottom-right 弹 toast 提示。

| 平台 | 下载(**GitCode 优先**) | 下载(GitHub 备用) | 说明 |
|------|---------------------|--------------------|------|
| Windows 10/11 x64 | [whatsub_0.1.53_x64-setup.exe](https://gitcode.com/rjxznb/whatsub-release/releases/download/v0.1.53/whatsub_0.1.53_x64-setup.exe) | [GitHub](https://github.com/rjxznb/whatsub-releases/releases/download/v0.1.53/whatsub_0.1.53_x64-setup.exe) | NSIS 安装包,双击装到当前用户、无需管理员权限。**老版本(v0.1.22 及以前的 .msi 用户)请先在「程序和功能」里卸载老的 whatsub,再装新的 .exe** —— 两个安装系统的注册表入口不互通 |
| macOS Apple Silicon | [whatsub_0.1.53_aarch64.dmg](https://gitcode.com/rjxznb/whatsub-release/releases/download/v0.1.53/whatsub_0.1.53_aarch64.dmg) | [GitHub](https://github.com/rjxznb/whatsub-releases/releases/download/v0.1.53/whatsub_0.1.53_aarch64.dmg) | 已 Apple Developer ID 签名 + 公证,双击 .dmg → **务必拖进 Applications 文件夹再打开**(直接从下载目录打开会触发 macOS App Translocation,自动更新会写不进去) |
| Intel Mac | — | — | 暂不支持 |

> 应用内自动更新和 yt-dlp 更新都优先尝试 GitCode；GitHub 是故障回退。稳定的应用更新清单为 [GitCode latest.json](https://gitcode.com/rjxznb/whatsub-release/raw/main/latest.json)。

## 主要功能

- **本地转录**:whisper.cpp 在本机跑,不上传音频;自动检测 GPU
  - Windows:Vulkan 后端,NVIDIA / AMD / Intel 显卡都加速
  - Mac:Metal 后端,Apple Silicon 原生
  - 无 GPU 自动 fallback CPU
- **任意 LLM**:DeepSeek / OpenAI / Kimi / Claude / Gemini / 智谱 / Qwen / SiliconFlow / Ollama,10 个预设 + 自定义
- **多站点视频导入**:内置 yt-dlp,支持 YouTube / B 站 / Instagram / X / TikTok 等;可选画质(480p / 720p / 1080p / 原画)
- **可视化 cookies 登录**:启动你电脑上的 Edge / Chrome 在独立 profile 里登录目标站点,whatsub 通过 CDP 抓 cookies。会员视频 / 年龄限制 / 私有视频都能下载
- **yt-dlp 自动检查更新**(0.1.98+):启动时静默检查有没有新版 yt-dlp,有就弹提示、点「更新」一键装好(GitCode 优先,GitHub 兜底);也可 Settings → 更新 yt-dlp 手动更新。YouTube 哪天换 player JS 不用等 whatsub 发版
- **长视频字幕更准**(0.1.97+):超过 20 分钟的视频自动启用 VAD 智能分段,跳过音乐/静音段 —— 修复长片时间轴漂移、字幕反复乱码的问题,全自动无需设置
- **字幕导出**:英文 / 中文 / 双语 SRT,或将带高亮的字幕烧录进视频导出 MP4(可选 高 / 标准 / 流畅 三档画质),也支持都不勾字幕直接流复制原视频
- **词汇本**:⭐ 收藏重点短语,跨视频汇总,CSV 导出,深链跳回原片对应字幕段
- **公共 / 我的语料库**(0.1.56+):云端短语库,顶部 tag chip 多选筛选(18 个生活场景 + 自定义);公共库由我们整理(所有付费用户共享),我的库装的是浏览器插件在网页 / YouTube 上划词收藏的短语。每条短语点开能看带时间戳的视频出处(▶ 02:35 一键跳转 YouTube 嵌入播放器)
- **断点续传**:字幕识别引擎下载、长视频 AI 解析都可暂停/继续,状态自动落盘
- **24 小时免费试用**:首次启动自动领,期间所有功能可用;过期后输入授权码继续(3 台设备共享,永久有效)

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
