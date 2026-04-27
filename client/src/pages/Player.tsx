import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useAnalysis } from "../store/analysis";
import { useSettings } from "../store/settings";
import { useLibrary } from "../store/library";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useVideoSync } from "../hooks/useVideoSync";
import { VideoPlayer } from "../components/VideoPlayer";
import { SubtitleList } from "../components/SubtitleList";
import { KeyPhraseList } from "../components/KeyPhraseList";
import { ProgressBanner } from "../components/ProgressBanner";
import { parseSrt } from "../llm/parseSrt";
import { runAnalysis } from "../llm/analyze";
import { getProvider } from "../llm/providers";
import type { AnalysisResult, Subtitle } from "../llm/types";

type Tab = "subtitles" | "keyPhrases";

export function Player() {
  const { videoId } = useParams<{ videoId: string }>();
  const [searchParams] = useSearchParams();
  const srtPathFromImport = searchParams.get("srt");

  const { settings } = useSettings();
  const { library, reload } = useLibrary();
  const analysis = useAnalysis();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [tab, setTab] = useState<Tab>("subtitles");
  const [videoSrc, setVideoSrc] = useState<string>("");

  const entry = library.videos.find((v) => v.id === videoId);

  useTauriEvent<{ stage: string; video_id?: string; percent?: number }>(
    "pipeline-event",
    (e) => {
      if (e.video_id !== videoId) return;
      if (e.stage === "Downloading") analysis.setPhase("downloading", e.percent);
      if (e.stage === "ExtractingAudio") analysis.setPhase("extracting", 100);
      if (e.stage === "Transcribing") analysis.setPhase("transcribing", e.percent);
    }
  );

  useEffect(() => {
    if (!videoId) return;
    invoke<string>("video_source_path", { videoId }).then((p) =>
      setVideoSrc(convertFileSrc(p))
    );
  }, [videoId]);

  useEffect(() => {
    if (!videoId) return;
    (async () => {
      const cached = await invoke<AnalysisResult | null>("load_analysis", { videoId });
      if (cached) {
        analysis.setSubtitles(cached.subtitles);
        const { subtitles: _drop, ...summary } = cached;
        analysis.setSummary(summary);
        analysis.setPhase("complete");
        return;
      }

      analysis.startFor(videoId);
      const srt = srtPathFromImport
        ? await invoke<string | null>("load_transcript", { videoId })
        : await invoke<string | null>("load_transcript", { videoId });
      if (!srt) {
        analysis.setError("找不到 transcript.srt — 请重新解析");
        return;
      }

      analysis.setPhase("analyzing");
      const cues = parseSrt(srt);
      const provider = getProvider(settings);
      try {
        await runAnalysis({
          provider,
          cues,
          onCue: (c: Subtitle) => analysis.appendSubtitle(c),
          onSummary: (s) => analysis.setSummary(s),
        });
        const summary = useAnalysis.getState().summary;
        if (summary) {
          const finalAnalysis: AnalysisResult = {
            ...summary,
            subtitles: useAnalysis.getState().subtitles,
          };
          await invoke("save_analysis", { videoId, analysis: finalAnalysis });
          await invoke("library_set_status", {
            id: videoId,
            status: "ready",
            error: null,
          });
        }
        analysis.setPhase("complete");
        await reload();
      } catch (e) {
        analysis.setError(String(e));
        await invoke("library_set_status", {
          id: videoId,
          status: "failed",
          error: String(e),
        });
        await reload();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const currentIdx = useVideoSync(videoRef, analysis.subtitles);

  function jump(t: number) {
    if (videoRef.current) videoRef.current.currentTime = t;
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800">
        <Link to="/" className="text-zinc-400 hover:text-zinc-100 text-sm">
          ◀ Back
        </Link>
        <div className="flex-1 truncate text-sm">{entry?.title ?? videoId}</div>
      </header>

      <ProgressBanner />

      <div className="flex-1 flex min-h-0">
        <div className="w-[58%] border-r border-zinc-800">
          {videoSrc && <VideoPlayer ref={videoRef} src={videoSrc} />}
        </div>
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex border-b border-zinc-800 text-sm">
            {(["subtitles", "keyPhrases"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  "px-4 py-2 " +
                  (tab === t
                    ? "text-blue-400 border-b-2 border-blue-400"
                    : "text-zinc-400")
                }
              >
                {t === "subtitles"
                  ? "字幕"
                  : `重点短语 (${analysis.summary?.keyPhrases.length ?? 0})`}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0">
            {tab === "subtitles" && (
              <SubtitleList
                subtitles={analysis.subtitles}
                currentIdx={currentIdx}
                onJump={jump}
              />
            )}
            {tab === "keyPhrases" && (
              <KeyPhraseList phrases={analysis.summary?.keyPhrases ?? []} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
