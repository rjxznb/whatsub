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
  /** Optional login-site action attached to the error. */
  action?: SiteLoginAction;
  /** Visual prominence of the action button:
   *  - "primary"   = the cause is almost certainly auth-related
   *                  (specific pattern matched OR site is one where
   *                  ~every download needs cookies). UI replaces the
   *                  red error card with an amber action card.
   *  - "secondary" = the cause is something else (network / format /
   *                  unknown), but cookies MIGHT help and the site
   *                  supports our login flow. UI keeps the red
   *                  error card and shows a smaller "🔑 试试登录"
   *                  link below it.
   *  Defaults to "primary" when `action` is set without an explicit
   *  tier — matches the pre-tier behaviour. */
  actionTier?: "primary" | "secondary";
  /** True when re-running the same import has a real chance of
   *  succeeding without user intervention — network / TLS / DNS /
   *  CDN flakes, transient YouTube player-JS state. The UI surfaces
   *  a 「重试」 button when true. False for deterministic errors
   *  (video private / banned / cookies expired / age-gated) where a
   *  retry would just hit the same wall. */
  retryable?: boolean;
}

export interface SiteLoginAction {
  kind: "login-site";
  /** Stable id matching backend's `site_presets()` (e.g. "youtube",
   *  "instagram", "bilibili"). */
  siteKey: string;
  /** Display name shown in the button: "立即登录 <siteLabel>". */
  siteLabel: string;
  /** URL the browser should open. */
  loginUrl: string;
  /** Domains the cookie harvest should filter to. */
  harvestDomains: string[];
}

/** Preset args for the in-app login flow, indexed by site_key.
 *  Source of truth is `site_presets()` in Rust, but we keep a small
 *  copy here so friendlyError can build SiteLoginAction without
 *  needing an async fetch at error-render time. */
const LOGIN_PRESETS: Record<
  string,
  { label: string; loginUrl: string; harvestDomains: string[] }
> = {
  youtube: {
    label: "YouTube",
    loginUrl: "https://www.youtube.com/",
    harvestDomains: ["youtube.com", "google.com", "googleusercontent.com"],
  },
  bilibili: {
    label: "哔哩哔哩",
    loginUrl: "https://www.bilibili.com/",
    harvestDomains: ["bilibili.com", "hdslb.com"],
  },
  instagram: {
    label: "Instagram",
    loginUrl: "https://www.instagram.com/",
    harvestDomains: ["instagram.com", "cdninstagram.com"],
  },
  x: {
    label: "X (Twitter)",
    loginUrl: "https://x.com/login",
    harvestDomains: ["x.com", "twitter.com"],
  },
  tiktok: {
    label: "TikTok",
    loginUrl: "https://www.tiktok.com/login",
    harvestDomains: ["tiktok.com"],
  },
};

function loginAction(siteKey: string): SiteLoginAction | undefined {
  const p = LOGIN_PRESETS[siteKey];
  if (!p) return undefined;
  return {
    kind: "login-site",
    siteKey,
    siteLabel: p.label,
    loginUrl: p.loginUrl,
    harvestDomains: p.harvestDomains,
  };
}

/**
 * @param raw       Whatever Tauri/Rust returned (already a string)
 * @param phase     Optional pipeline phase context — disambiguates errors
 *                  that could happen at different stages (e.g. a network
 *                  error during "downloading" vs a model-load error
 *                  during "transcribing").
 * @param sourceUrl Optional source URL (yt-dlp input). Used to attach a
 *                  login action when we can identify the site as one
 *                  where ~every download fails without cookies
 *                  (Instagram / X / TikTok), even when the specific
 *                  error pattern is something we don't recognize.
 */
export function friendlyError(
  raw: string,
  phase?:
    | "downloading"
    | "extracting"
    | "transcribing"
    | "analyzing"
    | string,
  sourceUrl?: string,
): FriendlyError {
  const fe = classifyError(raw, phase);

  // Pattern detector already attached an action → that means a
  // strong keyword match (e.g. "sign in to confirm", "no csrf
  // token"). Promote to primary tier so the UI replaces the error
  // card with the action button.
  if (fe.action && !fe.actionTier) {
    return { ...fe, actionTier: "primary" };
  }

  // No specific match. If we know the source URL and it's a known
  // site, attach an action — tier depends on how often that site's
  // downloads actually need cookies.
  if (!fe.action && sourceUrl) {
    const site = detectKnownSite(sourceUrl);
    if (site) {
      return {
        ...fe,
        action: loginAction(site.siteKey),
        actionTier: site.tier,
      };
    }
  }
  return fe;
}

/** Detect the source site + how prominent the login button should
 *  be when an unrecognized error happens.
 *
 *  - "primary":   cookies are effectively mandatory for this site
 *                 (Instagram / X / TikTok). UI replaces the error
 *                 card with the action button.
 *  - "secondary": cookies sometimes help but the error might be
 *                 something else (YouTube / Bilibili). UI keeps the
 *                 red error card and adds a small "🔑 也许试试登录"
 *                 link below it.
 */
function detectKnownSite(
  url: string,
): { siteKey: string; tier: "primary" | "secondary" } | undefined {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const stripped = host.replace(/^(www|m|mobile)\./, "");

  // Strong: cookies essentially mandatory
  if (stripped === "instagram.com" || stripped.endsWith(".instagram.com")) {
    return { siteKey: "instagram", tier: "primary" };
  }
  if (
    stripped === "x.com" ||
    stripped.endsWith(".x.com") ||
    stripped === "twitter.com" ||
    stripped.endsWith(".twitter.com")
  ) {
    return { siteKey: "x", tier: "primary" };
  }
  if (stripped === "tiktok.com" || stripped.endsWith(".tiktok.com")) {
    return { siteKey: "tiktok", tier: "primary" };
  }

  // Weak: cookies might help but error often has other causes
  if (
    stripped === "youtube.com" ||
    stripped.endsWith(".youtube.com") ||
    stripped === "youtu.be"
  ) {
    return { siteKey: "youtube", tier: "secondary" };
  }
  if (
    stripped === "bilibili.com" ||
    stripped.endsWith(".bilibili.com") ||
    stripped === "b23.tv"
  ) {
    return { siteKey: "bilibili", tier: "secondary" };
  }
  return undefined;
}

function classifyError(
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
      title: "YouTube 要求登录验证",
      suggestion:
        "YouTube 在你这个 IP 触发了反机器人检测，需要登录一次。点下面的按钮直接走 whatsub 的快速登录流程 —— cookies 抓完之后回来再试。",
      details: raw,
      action: loginAction("youtube"),
    };
  }

  // ── Instagram: any combination of CSRF token / metadata extraction
  //    failure / explicit login-required text. These almost always
  //    boil down to "no logged-in session" — Instagram is strict
  //    about anonymous access. Detect BEFORE the generic network
  //    error fallback because the same yt-dlp run also produces
  //    "Unable to download webpage" as a downstream symptom.
  if (
    txt.includes("[instagram]") &&
    (txt.includes("no csrf token") ||
      txt.includes("metadata extraction failed") ||
      txt.includes("login required") ||
      txt.includes("login is required") ||
      txt.includes("requested content is not available") ||
      txt.includes("rate-limit reached") ||
      txt.includes("please log in"))
  ) {
    return {
      title: "Instagram 需要登录后才能下载",
      suggestion:
        "Instagram 不允许匿名访问大多数视频。点下面的按钮一键登录，cookies 抓完之后回来再试。",
      details: raw,
      action: loginAction("instagram"),
    };
  }

  // ── Bilibili: 需要登录的视频 / 大会员专享 / 充电视频
  if (
    (txt.includes("[bilibili]") || txt.includes("bilibili.com")) &&
    (raw.includes("需要登录") ||
      raw.includes("会员") ||
      raw.includes("充电") ||
      txt.includes("login required") ||
      txt.includes("not available for guests"))
  ) {
    return {
      title: "B 站这个视频需要登录账号",
      suggestion:
        "可能是大会员 / 充电专属 / 仅登录可见。点下面的按钮一键登录 B 站，cookies 抓完之后回来再试。",
      details: raw,
      action: loginAction("bilibili"),
    };
  }

  // ── X (Twitter): NSFW / private / login-required
  if (
    (txt.includes("[twitter]") || txt.includes("x.com")) &&
    (txt.includes("login required") ||
      txt.includes("authorization") ||
      txt.includes("not authorized") ||
      txt.includes("nsfw_loggedout"))
  ) {
    return {
      title: "X 这条推文需要登录",
      suggestion:
        "可能是限制级 / 私密推文 / 仅关注者可见。点下面的按钮一键登录 X，cookies 抓完之后回来再试。",
      details: raw,
      action: loginAction("x"),
    };
  }

  if (
    txt.includes("getaddrinfo failed") ||
    txt.includes("urlopen error") ||
    txt.includes("unable to download webpage") ||
    txt.includes("connection timed out") ||
    txt.includes("connection refused") ||
    txt.includes("network is unreachable") ||
    // SSL handshake interrupted (common GFW-on-YouTube signature):
    //   "EOF occurred in violation of protocol (_ssl.c:..)"
    //   "ssl: certificate_verify_failed"
    //   "ssl: wrong_version_number"
    //   "ssl: unexpected eof while reading"
    txt.includes("eof occurred in violation of protocol") ||
    txt.includes("ssl:") ||
    txt.includes("ssl error") ||
    txt.includes("ssl_error") ||
    txt.includes("certificate verify failed")
  ) {
    return {
      title: "无法访问视频网站",
      suggestion:
        "可能是没挂代理（YouTube / Instagram / X 在中国大陆需要梯子），也可能是网络瞬时抖动 / TLS 握手被中间网络阻断。可以直接「重试」一下——如果反复失败，多半得挂梯子，或者在浏览器里先确认这个 URL 能正常打开。",
      details: raw,
      retryable: true,
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
