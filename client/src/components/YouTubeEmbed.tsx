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
  const src = `https://www.youtube.com/embed/${videoId}?start=${startSec}&autoplay=1&rel=0`;
  return (
    <iframe
      src={src}
      title={`YouTube ${videoId}`}
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
      width="100%"
      height="360"
      className={className ?? 'rounded border border-zinc-700'}
    />
  );
}
