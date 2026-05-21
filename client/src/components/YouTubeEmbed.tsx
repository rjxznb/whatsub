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
  return (
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
}
