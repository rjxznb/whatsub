import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
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
import { dedupSubtitles } from "../store/analysis";
import type { AnalysisResult, Subtitle } from "../llm/types";

type Tab = "subtitles" | "keyPhrases";

export function Player() {
  const { videoId } = useParams<{ videoId: string }>();
  const { settings } = useSettings();
  const { library, reload } = useLibrary();
  const analysis = useAnalysis();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [tab, setTab] = useState<Tab>("subtitles");
  const [videoSrc, setVideoSrc] = useState<string>("");

  // Resizable split between video pane (left) and subtitle pane (right).
  // Persisted as a percentage in localStorage; clamped to 25%-80%.
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [splitPct, setSplitPct] = useState<number>(() => {
    const saved =
      typeof window !== "undefined" ? window.localStorage.getItem("playerSplitPct") : null;
    const n = saved ? parseFloat(saved) : 58;
    return isNaN(n) ? 58 : Math.min(80, Math.max(25, n));
  });
  useEffect(() => {
    window.localStorage.setItem("playerSplitPct", String(splitPct));
  }, [splitPct]);

  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    const saved =
      typeof window !== "undefined"
        ? window.localStorage.getItem("playerPanelOpen")
        : null;
    return saved === null ? true : saved === "1";
  });
  useEffect(() => {
    window.localStorage.setItem("playerPanelOpen", panelOpen ? "1" : "0");
  }, [panelOpen]);

  const startSplitDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const rect = splitContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(80, Math.max(25, pct)));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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
    // StrictMode in dev double-mounts components. Without this token, the first
    // mount's runAnalysis would keep streaming and appending while the second
    // mount kicks off another LLM call — producing two parallel sets of cues.
    let cancelled = false;

    (async () => {
      const cached = await invoke<AnalysisResult | null>("load_analysis", { videoId });
      if (cancelled) return;

      if (cached) {
        // Dedup any duplicates already on disk from before this fix; if dedup
        // changed the count, persist the cleaned version back so the file
        // self-heals on next open.
        const cleaned = dedupSubtitles(cached.subtitles);
        analysis.setSubtitles(cleaned);
        const { subtitles: _drop, ...summary } = cached;
        analysis.setSummary(summary);
        analysis.setPhase("complete");
        if (cleaned.length !== cached.subtitles.length) {
          const cleanedAnalysis: AnalysisResult = { ...cached, subtitles: cleaned };
          await invoke("save_analysis", { videoId, analysis: cleanedAnalysis });
        }
        return;
      }

      analysis.startFor(videoId);
      const srt = await invoke<string | null>("load_transcript", { videoId });
      if (cancelled) return;
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
          onCue: (c: Subtitle) => {
            if (cancelled) return;
            analysis.appendSubtitle(c);
          },
          onSummary: (s) => {
            if (cancelled) return;
            analysis.setSummary(s);
          },
        });
        if (cancelled) return;
        const summary = useAnalysis.getState().summary;
        if (summary) {
          const finalAnalysis: AnalysisResult = {
            ...summary,
            subtitles: dedupSubtitles(useAnalysis.getState().subtitles),
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
        if (cancelled) return;
        analysis.setError(String(e));
        await invoke("library_set_status", {
          id: videoId,
          status: "failed",
          error: String(e),
        });
        await reload();
      }
    })();

    return () => {
      cancelled = true;
    };
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

      <div ref={splitContainerRef} className="flex-1 flex min-h-0">
        <div
          style={panelOpen ? { width: `${splitPct}%` } : { width: "100%" }}
          className="shrink-0"
        >
          {videoSrc && (
            <VideoPlayer
              ref={videoRef}
              src={videoSrc}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen((v) => !v)}
            />
          )}
        </div>
        {panelOpen && (
          <>
            <div
              onMouseDown={startSplitDrag}
              onDoubleClick={() => setSplitPct(58)}
              title="拖动调整比例 · 双击重置 58%"
              className="w-1 bg-zinc-800 hover:bg-blue-400 active:bg-blue-500 cursor-col-resize shrink-0 transition-colors"
            />
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
          </>
        )}
      </div>
    </div>
  );
}
