// src/components/PhrasePlayer.tsx
//
// Shared per-video player for the grouped vocab view. One instance per expanded
// video card (NOT per phrase row), seekable from the phrase rows.
//
// Resolution tiers (deviates from the original 3-tier plan):
//   1. local file (video_source_path → asset:// via convertFileSrc)
//   2. YouTube embed fallback (youtubeId, or videoId if it looks like a YT id)
// The middle "OSS CDN" tier was dropped: CloudLibraryEntry exposes no direct
// playable mp4 URL on the desktop (only youtubeId/sourceUrl), so there's nothing
// to resolve without a new backend endpoint. Local → YouTube covers both the
// downloaded and the cloud-only cases.

import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

interface Props {
  /** Library entry id (also the local-file lookup key). */
  videoId: string;
  /** YouTube id fallback when there's no local file. */
  youtubeId?: string;
  /** Seconds to seek to (re-applied whenever it changes). */
  seekTo?: number;
}

type Resolution =
  | { state: "loading" }
  | { state: "local"; fileSrc: string }
  | { state: "youtube"; videoId: string }
  | { state: "unavailable" };

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

export function PhrasePlayer({ videoId, youtubeId, seekTo }: Props) {
  const [res, setRes] = useState<Resolution>({ state: "loading" });
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let cancelled = false;
    setRes({ state: "loading" });
    (async () => {
      let localPath = "";
      try {
        localPath = await invoke<string>("video_source_path", { videoId });
      } catch {
        localPath = "";
      }
      if (cancelled) return;
      if (localPath) {
        setRes({ state: "local", fileSrc: convertFileSrc(localPath) });
        return;
      }
      const yt = youtubeId ?? (YT_ID.test(videoId) ? videoId : undefined);
      setRes(yt ? { state: "youtube", videoId: yt } : { state: "unavailable" });
    })();
    return () => {
      cancelled = true;
    };
  }, [videoId, youtubeId]);

  // Seek the local <video> when seekTo changes (YouTube reloads via key below).
  useEffect(() => {
    if (res.state !== "local" || seekTo == null) return;
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, seekTo);
  }, [seekTo, res.state]);

  if (res.state === "loading") {
    return <div className="aspect-video w-full grid place-items-center bg-zinc-900 text-xs text-zinc-500">加载视频…</div>;
  }
  if (res.state === "unavailable") {
    return <div className="aspect-video w-full grid place-items-center bg-zinc-900 text-xs text-zinc-500">视频已不可用</div>;
  }
  if (res.state === "local") {
    return (
      <video
        ref={videoRef}
        src={res.fileSrc}
        controls
        className="aspect-video w-full bg-black"
        onLoadedMetadata={(e) => {
          if (seekTo != null) e.currentTarget.currentTime = Math.max(0, seekTo);
        }}
      />
    );
  }
  // youtube — key on seekTo so a new start= reloads the iframe to that moment.
  const start = seekTo != null ? Math.max(0, Math.floor(seekTo)) : 0;
  return (
    <iframe
      key={start}
      src={`https://www.youtube-nocookie.com/embed/${res.videoId}?start=${start}&rel=0`}
      title={`YouTube ${res.videoId}`}
      allow="encrypted-media; picture-in-picture"
      allowFullScreen
      className="aspect-video w-full border-0 bg-black"
    />
  );
}
