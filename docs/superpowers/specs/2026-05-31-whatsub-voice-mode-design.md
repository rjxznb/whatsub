# whatsub 全屏语音模式 (Voice Mode) 设计

> 2026-05-31 · 分支 `feat/ai-agent`

## 一句话

一个像 ChatGPT 语音 / 豆包桌面端那样的**全屏语音对话界面**：一个会听会说的「光球」，你直接开口说英语，它用语音回应——免手操作（自动检测你说完），全程本地（whisper 转录 + OS 原生 TTS），做你的英语口语陪练。

## 用户已定的两个决策
- **形态**：独立全屏语音模式（不是接进 ChatBar，也不是只在角色扮演里）。一个专门的语音界面。
- **交互**：自动检测说完（hands-free VAD），不是按住说话。

## 角色定位
英语口语陪练。默认用**英语**跟你对话（en-US 语音），你卡住时可以切中文解释；鼓励你多开口、轻度纠错、把话题接下去。系统提示词可后续配置，v1 固定为「友好的英语口语陪练」。

## 架构（全本地，BYOK LLM）

```
[麦克风] getUserMedia → Web Audio (16kHz mono PCM)
   │
   ▼
[能量 VAD] AnalyserNode RMS：检测说话开始 → 持续录音 → 静音 N 毫秒判定说完
   │  (一段 utterance 的 PCM)
   ▼
[编码 WAV] JS 把 PCM 编成 16kHz mono WAV (base64)
   │
   ▼
[STT] Rust 命令 voice_transcribe(wavBase64, lang) → whisper-cli → 文本
   │
   ▼
[LLM] provider.stream(口语陪练 system + 对话历史 + 你这句) → 回应文本（流式）
   │
   ▼
[TTS] tts.ts ttsSpeak(回应, en-US) → OS 语音读出
   │
   ▼ (TTS 结束)
回到 [监听]，循环
```

**Barge-in（插话打断）**：AI 说话时如果检测到你开口（VAD 触发），立即 `ttsCancel()` 停止朗读，转入监听——像真人对话能打断。

## 状态机（VoiceMode）

```
idle → listening → (检测到说话) capturing → (静音判定) transcribing
     → thinking (LLM 流式) → speaking (TTS) → listening …
错误/无语音 → 回到 listening
用户关闭 → 释放麦克风 + 停 TTS + 退出
```

光球 UI 按状态变化：
- **listening**：柔和呼吸 + 随麦克风音量轻微起伏
- **capturing**：更亮、跟随你的音量律动
- **transcribing / thinking**：旋转/脉冲（「在想」）
- **speaking**：跟随 TTS 节奏的波纹

界面：全屏暗背景 + 居中光球 + 下方一行实时字幕（你说的 / AI 说的，滚动）+ 右上角关闭、左下角静音/麦克风开关。配色沿用 app 的 zinc-950 + sky-500 accent（光球用 sky 渐变）。

## 技术选择

- **STT = 复用 bundled whisper.cpp**（离线、无 key、无额外成本、与 app 一致）。新增 Rust 命令 `voice_transcribe`，复用 `pipeline/whisper.rs` 的 whisper-cli 调用，但：输出纯文本（`-otxt`）、不发 pipeline 事件、语言可传（默认 `auto` 或 `en`）、用较小/快的已下载模型降低延迟。RTX 4090 上 5 秒音频 large-v3 ~0.5s，可接受。
- **VAD = 能量阈值法**（AnalyserNode RMS + 静音超时），零依赖。v1 够用；以后可换 silero-vad。
- **音频 = Web Audio 原生 16kHz mono PCM → JS 编 WAV**。避开 MediaRecorder 的 webm/opus + ffmpeg 转码，whisper 直接吃 16kHz WAV。
- **TTS = 已有 tts.ts**（Web Speech API → OS 原生）。语音模式默认 en-US 语音。
- **LLM = 现有 provider.stream**（用户配置的 LLM），口语陪练 system prompt。

## ⚠️ 环境不确定项（需用户真机验证）
1. **WebView2 麦克风权限**：Tauri 2 的 WebView2 里 `getUserMedia({audio})` 是否直接可用 / 是否弹权限 / 是否需要 tauri.conf 配置。这是整个功能的地基，必须先验证。**先做一个最小「点一下→录 3 秒→whisper 转文字→显示」的打通，再做完整 UI。**
2. **whisper 短音频延迟**：实测每轮 STT 延迟，调模型大小。
3. **VAD 阈值/静音时长**：需要真机调（环境噪音、麦克风增益）。给可调参数 + 合理默认（如静音 800ms 判定说完）。

## 落地顺序（de-risk first）
1. **STT 地基**：Rust `voice_transcribe` 命令 + TS 封装。先用一个临时按钮（录固定时长 → 转文字）验证 mic→whisper 打通。← 最高风险，先做。
2. **mic + 能量 VAD 模块**：`voiceCapture.ts`（getUserMedia + Web Audio + RMS VAD + WAV 编码 + utterance 回调）。
3. **会话循环**：`voiceConversation.ts` 状态机（listening→capture→stt→llm→tts→loop + barge-in）。
4. **全屏光球 UI**：`VoiceMode.tsx`（状态可视化 + 字幕 + 控制）。
5. **入口 + 挂载**：在某处加「语音对话」入口（首页/播放页/全局按钮），全屏 portal 挂载，复用 TutorPortalRoot 风格或独立。

## 范围外（v1 不做）
- silero-vad ML 模型（先用能量法）
- 实时流式 STT（先用「说完一段→转录」）
- 语音模式的多角色/可配置 persona（先固定英语陪练）
- 多语言 TTS 语音挑选 UI（先 en-US 默认 + 中文回退）

## 与现有代码的关系
- 复用：`pipeline/whisper.rs`（whisper-cli 调用）、`tts.ts`（朗读）、`llm/providers`（LLM 流式）、`components/tutor/styles.ts`（配色）。
- 新增：`commands/voice.rs`（Rust STT 命令）、`src/voice/`（voiceCapture / voiceConversation / 类型）、`src/components/voice/VoiceMode.tsx`。
- 不改：tutor 的精讲/角色扮演/专项逻辑（语音模式是独立新表面）。
```
