// Translates raw subprocess / pipeline error text (yt-dlp / ffmpeg / whisper-cli
// stderr, AppError::Subprocess strings) into something a non-technical user
// can act on.
//
// The matcher is fragment-based on lowercased input — patterns ordered most-
// specific to most-generic. The original raw text is preserved as `details`
// so power users can still copy/share it for support.

export interface FriendlyError {
  /** One-line user-facing headline. */
  title: string;
  /** What to do about it (one short sentence, actionable). */
  suggestion: string;
  /** Original raw error text (preserved for the collapsible "技术详情" expander). */
  details: string;
}

/**
 * @param raw   Whatever Tauri/Rust returned (already a string)
 * @param phase Optional pipeline phase context — disambiguates errors that
 *              could happen at different stages (e.g. a network error during
 *              "downloading" vs a model-load error during "transcribing").
 */
export function friendlyError(
  raw: string,
  phase?:
    | "downloading"
    | "extracting"
    | "transcribing"
    | "analyzing"
    | string,
): FriendlyError {
  const txt = raw.toLowerCase();

  // ── YouTube / yt-dlp specific ──────────────────────────────────────

  if (txt.includes("sign in to confirm you're not a bot")) {
    return {
      title: "YouTube 要求登录验证（cookies）",
      suggestion:
        "这是最常见的下载失败原因。点 URL 输入框右边的「?」按钮，按里面教程导出 cookies.txt 后在设置页配上即可。",
      details: raw,
    };
  }

  if (
    txt.includes("getaddrinfo failed") ||
    txt.includes("urlopen error") ||
    txt.includes("unable to download webpage") ||
    txt.includes("connection timed out") ||
    txt.includes("connection refused") ||
    txt.includes("network is unreachable")
  ) {
    return {
      title: "无法访问视频网站",
      suggestion:
        "可能是没挂代理（YouTube 在中国大陆需要梯子），也可能是网络不通。先在浏览器里试试能不能正常打开这个 URL。",
      details: raw,
    };
  }

  if (txt.includes("members-only video") || txt.includes("members only")) {
    return {
      title: "这是频道会员专享视频",
      suggestion: "需要会员资格才能看，下不了。换个公开视频试试。",
      details: raw,
    };
  }

  if (txt.includes("sign in to confirm your age")) {
    return {
      title: "视频有 18+ 年龄限制",
      suggestion: "需要用一个已确认成年的账号的 cookies 才能下载。",
      details: raw,
    };
  }

  if (
    txt.includes("not available in your country") ||
    txt.includes("not made this video available in your country")
  ) {
    return {
      title: "视频在你所在区域被锁定",
      suggestion: "区域限制视频，换个支持的代理节点（如美/日服务器）或换视频。",
      details: raw,
    };
  }

  if (
    txt.includes("this video is private") ||
    txt.includes("removed by the user") ||
    txt.includes("video unavailable")
  ) {
    return {
      title: "视频不可用",
      suggestion: "可能是私密视频、已被删除，或者 URL 输入有误。检查一下链接。",
      details: raw,
    };
  }

  if (
    txt.includes("requested format is not available") ||
    txt.includes("only images are available")
  ) {
    return {
      title: "无法解析视频格式",
      suggestion:
        "通常是 YouTube 反爬虫机制升级了。先看看应用有没有可更新版本；如果已经是最新版还遇到，临时换其他视频试试。",
      details: raw,
    };
  }

  if (txt.includes("ffmpeg not found")) {
    return {
      title: "找不到内置的视频处理工具",
      suggestion: "应用安装可能不完整，建议从 release 页重新下载安装包覆盖安装。",
      details: raw,
    };
  }

  // ── Whisper / 字幕识别 ─────────────────────────────────────────────

  if (
    raw.includes("whisper-cli exit -1073741515") ||
    txt.includes("status_dll_not_found")
  ) {
    return {
      title: "字幕识别引擎缺少核心库",
      suggestion:
        "安装包不完整。请去 release 页下载最新 .msi 重新安装一次（v0.1.8 起已修复）。",
      details: raw,
    };
  }

  if (
    raw.includes("whisper-cli exit -1073741795") ||
    txt.includes("status_illegal_instruction") ||
    txt.includes("illegal instruction")
  ) {
    return {
      title: "你的 CPU 太老，跑不动当前字幕识别引擎",
      suggestion:
        "v0.1.7 的已知问题，请更新到 v0.1.8+。去 release 页下载最新 .msi 重装即可。",
      details: raw,
    };
  }

  if (raw.includes("whisper-cli terminated abnormally")) {
    return {
      title: "字幕识别引擎无法启动",
      suggestion:
        "可能原因：(1) 模型文件不完整或损坏 → 设置页里删除当前档位重新下载；(2) 内存不够 → 换更小的档位（极速 / 轻量）；(3) 安装包不完整 → 重新下载最新版安装。极少数情况下 macOS 用户可能需要把 app 拖进 /Applications/ 再打开。",
      details: raw,
    };
  }

  if (txt.includes("model not downloaded")) {
    return {
      title: "字幕识别模型还没下载",
      suggestion: "去设置页 → 「Whisper 模型」选一档下载，或回引导页完成下载。",
      details: raw,
    };
  }

  if (
    raw.includes("status_access_violation") ||
    raw.includes("STATUS_HEAP_CORRUPTION") ||
    txt.includes("out of memory")
  ) {
    return {
      title: "内存不够或显卡崩了",
      suggestion:
        "当前模型档对你电脑可能太大。去设置页换一档更小的模型（极速 / 轻量），或关掉其他占内存的程序后重试。",
      details: raw,
    };
  }

  // ── 输入校验 / 用户操作类 ────────────────────────────────────────────

  if (raw === "请输入 URL" || raw === "请选择文件") {
    // already friendly
    return { title: raw, suggestion: "", details: "" };
  }

  if (txt.includes("whisper 模型未配置")) {
    return {
      title: "字幕识别模型未配置",
      suggestion: "去设置页选一档 Whisper 模型并下载。",
      details: raw,
    };
  }

  // ── 通用退化分类（按 phase 给方向） ──────────────────────────────────

  if (txt.includes("yt-dlp exit") || txt.includes("yt-dlp failed")) {
    return {
      title: phase === "downloading" ? "下载视频失败" : "处理视频源失败",
      suggestion:
        "看下方「详细日志」找具体原因，或点 URL 输入框旁的「?」查看常见原因表。",
      details: raw,
    };
  }

  if (txt.includes("ffmpeg exit") || txt.includes("ffmpeg failed")) {
    return {
      title: "音频提取失败",
      suggestion: "视频文件可能损坏或格式不支持。换个视频试试。",
      details: raw,
    };
  }

  if (txt.includes("whisper-cli exit") || txt.includes("whisper failed")) {
    return {
      title: "字幕识别失败",
      suggestion:
        "看「详细日志」找具体原因。如果反复挂，去设置页换更小的模型档（极速 / 轻量）。",
      details: raw,
    };
  }

  // 真兜底
  return {
    title: phase ? `${phaseLabel(phase)}失败` : "处理失败",
    suggestion: "看下方「详细日志」找原因，或重启应用重试。",
    details: raw,
  };
}

function phaseLabel(p: string): string {
  switch (p) {
    case "downloading":
      return "下载";
    case "extracting":
      return "音频提取";
    case "transcribing":
      return "字幕识别";
    case "analyzing":
      return "翻译解析";
    default:
      return "处理";
  }
}
