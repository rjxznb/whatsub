import { openUrl } from '@tauri-apps/plugin-opener';

export interface ParsedYouTube {
  videoId: string;
  startSec: number;
}

export function parseYouTubeUrl(input: string): ParsedYouTube | null {
  try {
    const u = new URL(input);
    let videoId: string | null = null;
    if (u.hostname === 'youtu.be') {
      videoId = u.pathname.slice(1).split('/')[0] ?? null;
    } else if (u.hostname.endsWith('youtube.com')) {
      videoId = u.searchParams.get('v');
    }
    if (!videoId || !/^[A-Za-z0-9_-]{6,}$/.test(videoId)) return null;
    const t = u.searchParams.get('t') ?? u.searchParams.get('start');
    let startSec = 0;
    if (t) {
      const m = /^(\d+)s?$/.exec(t);
      if (m) startSec = parseInt(m[1]!, 10);
    }
    return { videoId, startSec };
  } catch {
    return null;
  }
}

/** Canonical watch URL for the system browser, carrying the timestamp over so
 *  the user lands on the same spot they were trying to reach in the embed.
 *  `&t=<n>s` (seconds suffix) is the form YouTube's watch page expects. */
export function watchUrlFor(videoId: string, startSec = 0): string {
  const t = Math.max(0, Math.floor(startSec));
  return t > 0
    ? `https://www.youtube.com/watch?v=${videoId}&t=${t}s`
    : `https://www.youtube.com/watch?v=${videoId}`;
}

interface Props {
  videoId: string;
  startSec?: number;
  className?: string;
}

export function YouTubeEmbed({ videoId, startSec = 0, className }: Props) {
  // youtube-nocookie.com is YouTube's "privacy-enhanced" embed host: skips
  // cookies until the user clicks play, which sidesteps WebView2's
  // Tracking Prevention storage-block spam and several "navigator.plugins
  // undefined" embed-script crashes that come from the cookie/storage
  // fallback path. Autoplay also dropped — Edge WebView2 blocks unmuted
  // autoplay without a user gesture and the resulting failed-load can
  // leave the iframe blank.
  //
  // start MUST be an integer — YouTube silently treats `?start=5.6` as
  // invalid and falls back to 0, so the saved-with-decimal timestamps
  // (e.g. 5.646522 captured from player.getCurrentTime()) wouldn't seek
  // at all. Math.floor — never skip the moment, only land before it.
  const startInt = Math.max(0, Math.floor(startSec));
  // cc_load_policy=1 forces captions on by default if the video has them —
  // this is a learning tool, captions are the whole point. cc_lang_pref=en
  // picks English as the preferred subtitle language when the video has
  // multiple track options.
  const src = `https://www.youtube-nocookie.com/embed/${videoId}?start=${startInt}&rel=0&cc_load_policy=1&cc_lang_pref=en`;
  const iframe = (
    <iframe
      src={src}
      title={`YouTube ${videoId}`}
      allow="encrypted-media; picture-in-picture; clipboard-write"
      allowFullScreen
      width="100%"
      height="360"
      className={className ?? 'rounded border border-zinc-700'}
    />
  );

  // A caller passing `className` owns its own layout (e.g. the agent's
  // YouTubeResults fills a 16:9 box with `absolute inset-0`). Wrapping that in
  // a static div would break the positioning, and a hint bar has no room in a
  // thumbnail-sized card — so those get the bare iframe.
  if (className) return iframe;

  return (
    <div className="space-y-1">
      {iframe}
      {/* Always-on escape hatch. When YouTube decides the current exit IP looks
          like bot traffic it serves an anti-abuse page carrying
          X-Frame-Options: DENY instead of the player — WebView2 then renders its
          opaque "已阻止此内容。请与网站所有者联系" page and the user has no idea
          what to do (2026-07-13: a flagged shared proxy node did exactly this;
          switching nodes fixed it). We can't detect that reliably — an
          XFO-refused iframe fires no onError — so instead of guessing we just
          always offer the way out. Costs one line when playback is fine. */}
      <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
        <span>显示「已阻止此内容」？通常是代理节点被判定为异常流量，换个节点即可。</span>
        <button
          type="button"
          onClick={() => void openUrl(watchUrlFor(videoId, startInt)).catch(() => {})}
          className="shrink-0 underline hover:text-zinc-300"
        >
          在浏览器中打开
        </button>
      </div>
    </div>
  );
}
