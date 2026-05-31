// src/components/tutor/styles.ts
//
// Shared visual language for the 私教 (tutor) overlays. Deliberately matches
// the rest of the app — flat zinc surfaces with thin `border-zinc-800`
// borders (like Player/Settings), NOT frosted glass — and uses blue-500 as the
// single restrained accent. Centralising the tokens keeps every overlay
// (pre-class / lesson / roleplay / remediation / report) cohesive and premium.

/** The card surface every overlay sits on. Flat zinc + hairline border. */
export const TUTOR_CARD =
  "bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl shadow-black/60 text-zinc-100";

/** Full-screen dim behind the card. Subtle blur, not a heavy frost. */
export const TUTOR_BACKDROP =
  "fixed inset-0 z-[100] bg-zinc-950/80 backdrop-blur-sm flex items-center justify-center p-6";

/** Small section eyebrow label (教学点 / 准备开课 / 复盘 …). */
export const TUTOR_EYEBROW =
  "text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500";

/** Primary call-to-action — the app's blue accent with black text, matching
 *  the Library/Import primary buttons (bg-blue-500 hover:bg-blue-400 text-black). */
export const BTN_PRIMARY =
  "px-4 py-2 rounded-lg text-sm font-medium bg-blue-500 hover:bg-blue-400 text-black transition-colors disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed";

/** Secondary filled button (重听 / 再试一次). */
export const BTN_SUBTLE =
  "px-4 py-2 rounded-lg text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors";

/** Tertiary ghost button (取消 / 回主页 / 关掉). */
export const BTN_GHOST =
  "px-4 py-2 rounded-lg text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors";

/** Inset surface for nested content (参考答案 box, etc.). */
export const TUTOR_INSET =
  "bg-zinc-950/60 border border-zinc-800 rounded-lg";

/** Small round icon button used in overlay headers (mute toggle, replay). */
export const ICON_BTN =
  "h-8 w-8 grid place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors";

/** Textarea used for answers / chat input. */
export const TUTOR_TEXTAREA =
  "w-full bg-zinc-950/60 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500/70 transition-colors resize-none";
