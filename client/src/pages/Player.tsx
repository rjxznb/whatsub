import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
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

    // Throttled partial-save handle. Every onCue triggers it; if another cue
    // arrives within 800ms the timer resets. Net effect: at most ~1 disk write
    // per second of streaming. On unmount we force a final immediate save to
    // capture the last cues before the throttle window expires.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPartialSave = () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const state = useAnalysis.getState();
      if (state.videoId !== videoId || state.subtitles.length === 0) return;
      const partial: AnalysisResult = {
        subtitles: dedupSubtitles(state.subtitles),
        keyPhrases: state.summary?.keyPhrases ?? [],
      };
      invoke("save_analysis", { videoId, analysis: partial }).catch((e) =>
        console.error("partial save failed", e)
      );
    };
    const schedulePartialSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flushPartialSave, 800);
    };

    (async () => {
      const cached = await invoke<AnalysisResult | null>("load_analysis", { videoId });
      if (cancelled) return;

      // Need cues count to decide complete / partial / fresh, so load
      // transcript up-front (cheap — small file on disk).
      const srt = await invoke<string | null>("load_transcript", { videoId });
      if (cancelled) return;
      if (!srt) {
        // No transcript means import failed somewhere. Whatever's cached is
        // unusable; show error.
        if (cached) {
          analysis.setSubtitles(dedupSubtitles(cached.subtitles));
          const { subtitles: _drop, ...summary } = cached;
          analysis.setSummary(summary);
          analysis.setPhase("complete");
        } else {
          analysis.setError("找不到 transcript.srt — 请重新解析");
        }
        return;
      }
      const cues = parseSrt(srt);
      const cleanedCachedCues = cached ? dedupSubtitles(cached.subtitles) : [];

      // ── Complete: cached has every cue. Use as-is. ──
      if (cached && cleanedCachedCues.length >= cues.length) {
        analysis.setSubtitles(cleanedCachedCues);
        const { subtitles: _drop, ...summary } = cached;
        analysis.setSummary(summary);
        analysis.setPhase("complete");
        // Self-heal: if dedup changed the count, persist cleaned version.
        if (cleanedCachedCues.length !== cached.subtitles.length) {
          await invoke("save_analysis", {
            videoId,
            analysis: { ...cached, subtitles: cleanedCachedCues },
          });
        }
        return;
      }

      // ── Partial: cached has some cues but not all. Resume from where we left off. ──
      // ── Or fresh start: no cache, run from cue 0. ──
      analysis.startFor(videoId);
      const remaining =
        cleanedCachedCues.length > 0
          ? cues.slice(cleanedCachedCues.length)
          : cues;
      // Pre-seed the store with already-analyzed cues so the UI shows them
      // immediately rather than blanking on resume.
      if (cleanedCachedCues.length > 0) {
        analysis.setSubtitles(cleanedCachedCues);
        if (cached?.keyPhrases) {
          analysis.setSummary({ keyPhrases: cached.keyPhrases });
        }
      }
      analysis.setPhase("analyzing");
      const provider = getProvider(settings);
      try {
        await runAnalysis({
          provider,
          cues: remaining,
          onCue: (c: Subtitle) => {
            if (cancelled) return;
            analysis.appendSubtitle(c);
            schedulePartialSave();
          },
          onSummary: (s) => {
            if (cancelled) return;
            analysis.setSummary(s);
            schedulePartialSave();
          },
        });
        if (cancelled) return;
        const summary = useAnalysis.getState().summary;
        if (summary) {
          const finalAnalysis: AnalysisResult = {
            ...summary,
            subtitles: dedupSubtitles(useAnalysis.getState().subtitles),
          };
          if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
          }
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
      // Force-save whatever cues have accumulated so the next session can
      // resume without re-billing the LLM for already-analyzed cues.
      flushPartialSave();
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
        <Link
          to="/"
          title="返回 Library"
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
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
