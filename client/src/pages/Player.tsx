import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileOutput, RefreshCw, Loader2 } from "lucide-react";
import { LessonIcon } from "../components/LessonIcon";
import { RoleplayIcon } from "../components/RoleplayIcon";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { ContextMenu } from "../components/ContextMenu";
import { ExportVideoModal } from "../components/ExportVideoModal";
import { subtitlesToSrt, sanitizeFilename } from "../utils/srt";
import { useAnalysis, type AnalysisPhase } from "../store/analysis";
import { useSettings } from "../store/settings";
import { useLibrary } from "../store/library";
import { usePlayerState } from "../store/playerState";
import { useVocabulary } from "../store/vocab";
import { loadAllDrafts, subscribeDrafts } from "../store/vocabDraft";
import { makeVocabId } from "../types/vocab";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useVideoSync } from "../hooks/useVideoSync";
import { VideoPlayer } from "../components/VideoPlayer";
import { SubtitleList } from "../components/SubtitleList";
import { AutoScrollIcon } from "../components/AutoScrollIcon";
import { KeyPhraseList } from "../components/KeyPhraseList";
import { ProgressBanner } from "../components/ProgressBanner";
import { TinyModelHint } from "../components/TinyModelHint";
import {
  executeAnalysisSession,
  analysisPreviewFromJournal,
  openStoredAnalysisSession,
  type PersistedAnalysisSession,
} from "../llm/analysisSession";
import { analysisRetryMessage } from "../llm/analysisRetryMessage";
import { getProvider } from "../llm/providers";
import { RelayError } from "../llm/providers/relayErrors";
import { quotaDetailsFromRelayError } from "../llm/quotaRecovery";
import {
  runInBackground,
  takeOverBackground,
  retranscribeAndAnalyzeInBackground,
} from "../store/backgroundAnalyses";
import { captionStyleFromSettings } from "../types/settings";
import type { Settings } from "../types/settings";
import type { AnalysisResult, SrtCue } from "../llm/types";
import { useTutorRuntime } from "../store/tutorRuntime";
import { planLesson } from "../tutor/lessonPlanLLM";
import { loadLearnerProfile } from "../tutor/learnerProfile";
import { LessonResumeBanner } from "../components/tutor/LessonResumeBanner";
import { notify, confirmDialog } from "../store/appDialog";

type Tab = "subtitles" | "keyPhrases";

export function canEditSubtitles(phase: AnalysisPhase): boolean {
  return phase !== "analyzing";
}

export function restoreForegroundDurablePreview(
  videoId: string,
  session: PersistedAnalysisSession,
  totalCues: number,
): void {
  const state = useAnalysis.getState();
  if (state.videoId !== videoId) return;
  state.setAnalysisPreview(
    session.analysis,
    session.inflight ? analysisPreviewFromJournal(session.inflight) : null,
    totalCues,
  );
}

export function ownsForegroundAnalysis(
  videoId: string,
  expectedSession: PersistedAnalysisSession,
  currentSession: PersistedAnalysisSession | null,
): boolean {
  return currentSession === expectedSession
    && useAnalysis.getState().videoId === videoId;
}

export function ownsForegroundOperation(
  videoId: string,
  expectedEpoch: number,
  currentEpoch: number,
): boolean {
  return currentEpoch === expectedEpoch
    && useAnalysis.getState().videoId === videoId;
}

export function Player() {
  const { videoId } = useParams<{ videoId: string }>();
  const navigate = useNavigate();
  // Optional ?t=<seconds> deep-link target — used by the vocab page to jump
  // back to the cue where a phrase was first starred. Consumed once on
  // loadedmetadata; subsequent seeks are user-driven.
  const [searchParams] = useSearchParams();
  const seekTarget = (() => {
    const raw = searchParams.get("t");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  })();
  const { settings, save: saveSettings } = useSettings();
  // Caption box position is session-only — every fresh Player mount starts at
  // (0,0) regardless of what the previous video left behind. Persisted style
  // (color / size / opacity / highlights) still lives in settings.
  const [captionOffset, setCaptionOffset] = useState({ x: 0, y: 0 });
  const captionStyle = useMemo(
    () => ({
      ...captionStyleFromSettings(settings),
      offsetX: captionOffset.x,
      offsetY: captionOffset.y,
    }),
    [settings, captionOffset]
  );
  const onChangeCaptionStyle = (
    patch: Partial<Settings> & { captionOffsetX?: number; captionOffsetY?: number }
  ) => {
    // Offset patches go to local state (not persisted); everything else hits
    // saveSettings.
    if (patch.captionOffsetX !== undefined || patch.captionOffsetY !== undefined) {
      setCaptionOffset((cur) => ({
        x: patch.captionOffsetX ?? cur.x,
        y: patch.captionOffsetY ?? cur.y,
      }));
      const { captionOffsetX: _ox, captionOffsetY: _oy, ...rest } = patch;
      void _ox;
      void _oy;
      if (Object.keys(rest).length > 0) {
        void saveSettings({ ...settings, ...rest });
      }
      return;
    }
    void saveSettings({ ...settings, ...patch });
  };
  const { library, reload } = useLibrary();
  const analysis = useAnalysis();
  const vocab = useVocabulary();
  useEffect(() => {
    if (!vocab.loaded) void vocab.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [tab, setTab] = useState<Tab>("subtitles");
  const [videoSrc, setVideoSrc] = useState<string>("");
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const [reanalyzeMenu, setReanalyzeMenu] = useState<{ x: number; y: number } | null>(null);
  const reanalyzeButtonRef = useRef<HTMLButtonElement>(null);
  const [showExportVideo, setShowExportVideo] = useState(false);
  const [autoScrollSubtitle, setAutoScrollSubtitle] = useState<boolean>(() => {
    const saved =
      typeof window !== "undefined"
        ? window.localStorage.getItem("autoScrollSubtitle")
        : null;
    return saved === null ? true : saved === "1";
  });
  useEffect(() => {
    window.localStorage.setItem("autoScrollSubtitle", autoScrollSubtitle ? "1" : "0");
  }, [autoScrollSubtitle]);

  const [showCaptions, setShowCaptions] = useState<boolean>(() => {
    const saved =
      typeof window !== "undefined"
        ? window.localStorage.getItem("showCaptions")
        : null;
    return saved === "1";
  });
  useEffect(() => {
    window.localStorage.setItem("showCaptions", showCaptions ? "1" : "0");
  }, [showCaptions]);

  const [editingSubtitle, setEditingSubtitle] = useState(false);
  const [tutorPreparing, setTutorPreparing] = useState(false);
  const subtitleEditingAllowed = canEditSubtitles(analysis.phase);
  useEffect(() => {
    if (!subtitleEditingAllowed) setEditingSubtitle(false);
  }, [subtitleEditingAllowed]);

  // Resizable split between video pane (left) and subtitle pane (right).
  // Persisted as a percentage in localStorage; clamped to 25%-80%.
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [splitDragging, setSplitDragging] = useState(false);
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
    setSplitDragging(true);
    const onMove = (ev: MouseEvent) => {
      const rect = splitContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(80, Math.max(25, pct)));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSplitDragging(false);
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

  // Honor ?t=<seconds> once the video element has metadata. We bind to
  // loadedmetadata on the underlying element each time videoSrc/seekTarget
  // changes; React's effect cleanup removes the prior listener.
  useEffect(() => {
    if (seekTarget == null) return;
    const el = videoRef.current;
    if (!el || !videoSrc) return;
    const seek = () => {
      try {
        el.currentTime = seekTarget;
      } catch {
        // some browsers throw if seeking before duration is known; ignore.
      }
    };
    if (el.readyState >= 1) {
      seek();
    } else {
      el.addEventListener("loadedmetadata", seek, { once: true });
      return () => el.removeEventListener("loadedmetadata", seek);
    }
  }, [videoSrc, seekTarget]);

  // The active producer owns one immutable backend lease. Each DeepSeek batch
  // is persisted before it is published to Zustand/the UI.
  const sessionRef = useRef<PersistedAnalysisSession | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const analysisRunRef = useRef<Promise<void> | null>(null);
  const cuesRef = useRef<SrtCue[] | null>(null);
  const manualSaveTailRef = useRef<Promise<void>>(Promise.resolve());
  const retranscribeEpochRef = useRef(0);

  const persistManualEdits = () => {
    if (!videoId) return;
    if (!canEditSubtitles(useAnalysis.getState().phase)) return;
    manualSaveTailRef.current = manualSaveTailRef.current.then(async () => {
      if (!canEditSubtitles(useAnalysis.getState().phase)) return;
      const session = sessionRef.current;
      const cues = cuesRef.current;
      if (!session || !cues) return;
      const stillOwnsSession = () =>
        ownsForegroundAnalysis(videoId, session, sessionRef.current);
      try {
        const state = useAnalysis.getState();
        const saved = await session.save({
          subtitles: state.subtitles,
          keyPhrases: state.summary?.keyPhrases ?? [],
          checkpoint: {
            ...session.analysis.checkpoint,
            revision: session.analysis.checkpoint.revision + 1,
          },
        });
        if (!stillOwnsSession()) return;
        analysis.setCommittedAnalysis(saved, cues.length);
      } catch (error) {
        if (!stillOwnsSession()) return;
        analysis.setError(
          error instanceof Error ? error.message : String(error),
          false,
          "analysis",
        );
      }
    });
  };

  const driveForegroundAnalysis = async () => {
    if (!videoId) return;
    const cues = cuesRef.current;
    const session = sessionRef.current;
    if (!cues || !session) return;
    const stillOwnsSession = () =>
      ownsForegroundAnalysis(videoId, session, sessionRef.current);
    if (session.analysis.checkpoint.phase === "complete") {
      analysis.setPhase("complete");
      return;
    }

    const localController = new AbortController();
    abortRef.current = localController;
    analysis.setRetryMessage(null);
    analysis.setPhase(
      "analyzing",
      cues.length > 0
        ? (session.analysis.checkpoint.nextCueOffset / cues.length) * 100
        : 100,
    );
    const provider = getProvider(settings);
    const entry = library.videos.find((v) => v.id === videoId);
    const style = entry?.analysisStyle ?? "colloquial";
    try {
      const completed = await executeAnalysisSession({
        session,
        provider,
        cues,
        style,
        signal: localController.signal,
        onCommitted: (persisted) => {
          if (!stillOwnsSession()) return;
          analysis.setCommittedAnalysis(persisted, cues.length);
        },
        onPreview: (committed, preview) => {
          if (!stillOwnsSession()) return;
          analysis.setAnalysisPreview(committed, preview, cues.length);
        },
        onRetry: (event) => {
          if (!stillOwnsSession()) return;
          analysis.setRetryMessage(analysisRetryMessage(event));
        },
      });
      if (!stillOwnsSession()) return;
      analysis.setRetryMessage(null);
      if (localController.signal.aborted || completed.checkpoint.phase !== "complete") {
        analysis.setPhase("paused");
        return;
      }
      if (completed.checkpoint.phase === "complete") {
        await invoke("library_set_status", {
          id: videoId,
          status: "ready",
          error: null,
        });
        if (!stillOwnsSession()) return;
        analysis.setPhase("complete", 100);
        await reload();
      }
    } catch (e: unknown) {
      if (!stillOwnsSession()) return;
      const isAbort =
        localController.signal.aborted ||
        (e instanceof DOMException && e.name === "AbortError") ||
        (typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError");
      if (isAbort) {
        analysis.setPhase("paused");
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      const upsell = e instanceof RelayError && e.upsell;
      const quotaError = quotaDetailsFromRelayError(
        e,
        session.analysis.checkpoint.nextCueOffset
          + (session.inflight?.entries.length ?? 0),
        cues.length,
      );
      analysis.setError(msg, upsell, "analysis", quotaError);
      await invoke("library_set_status", {
        id: videoId,
        status: "failed",
        error: msg,
      });
      await reload();
    } finally {
      if (abortRef.current === localController) abortRef.current = null;
    }
  };

  const startAnalysis = () => {
    if (analysisRunRef.current) return;
    // Lock editing synchronously, then wait for any edit already queued before
    // taking the next AI checkpoint revision.  This prevents two candidates
    // from being built from the same revision.
    analysis.setPhase("analyzing");
    const run = manualSaveTailRef.current.then(driveForegroundAnalysis);
    analysisRunRef.current = run;
    const clear = () => {
      if (analysisRunRef.current === run) analysisRunRef.current = null;
    };
    void run.then(clear, clear);
  };

  const onStop = () => {
    abortRef.current?.abort();
    analysis.setPhase("paused");
  };

  const onContinue = () => {
    startAnalysis();
  };

  /**
   * Hand off the in-flight analysis to the background scheduler so the
   * user can navigate away without losing progress. The current request is
   * aborted, then the exact same lease/session is handed to the background.
   * Canonical checkpoints and the durable inflight journal are rendered in
   * the queue widget.
   *
   * When the user returns to this Player later for the same videoId,
   * the mount effect calls takeOverBackground() and promotes whatever
   * the BG accumulated back into useAnalysis, then continues from
   * there in the foreground.
   */
  const onMoveToBackground = () => {
    if (!videoId) return;
    const cues = cuesRef.current;
    const session = sessionRef.current;
    if (!cues || !session) return;
    const entry = library.videos.find((v) => v.id === videoId);
    abortRef.current?.abort();
    sessionRef.current = null;
    runInBackground({
      videoId,
      label: entry?.title ?? videoId,
      cues,
      session,
      style: entry?.analysisStyle ?? "colloquial",
      waitFor: analysisRunRef.current ?? Promise.resolve(),
    });
    // Clear useAnalysis so:
    //  (1) the unmount cleanup below doesn't transition phase to
    //      "paused" (would otherwise make Library card show "继续解析"
    //      yellow text even though analysis is actively running in BG).
    //  (2) BG store is the sole owner of this video's analysis state
    //      until takeOverBackground hands it back on next Player mount.
    useAnalysis.getState().reset();
    navigate("/library");
  };

  // Bumped after a successful retranscribe to make the load useEffect
  // (keyed on [videoId, reloadKey]) re-run and pick up the freshly written
  // transcript.srt + restart AI analysis. Pure session state — no need to
  // persist or reset on unmount.
  const [reloadKey, setReloadKey] = useState(0);

  const onRetranscribe = async () => {
    if (!videoId) return;
    const operationEpoch = ++retranscribeEpochRef.current;
    const stillOwnsOperation = () =>
      ownsForegroundOperation(videoId, operationEpoch, retranscribeEpochRef.current);
    // Reset analysis store so phase/percent flow cleanly into the banner
    // via the existing useTauriEvent("pipeline-event") above. startFor sets
    // phase=downloading; we immediately move it to extracting since
    // retranscribe skips the download.
    analysis.startFor(videoId);
    analysis.setPhase("extracting", 0);
    try {
      const oldSession = sessionRef.current;
      sessionRef.current = null;
      await oldSession?.close();
      if (!stillOwnsOperation()) return;
      await invoke("retranscribe_video", {
        videoId,
        whisperModel: settings.whisperModel,
      });
      if (!stillOwnsOperation()) return;
      // The next loader compares transcript fingerprints and asks the backend
      // for an explicit reset lease when the new transcript differs.
      setReloadKey((k) => k + 1);
    } catch (e) {
      if (!stillOwnsOperation()) return;
      analysis.setError(String(e), false, "transcription");
    }
  };

  // Foreground 重新解析: re-run whisper + LLM in this view. Leaving the page
  // stops it — the unmount cleanup kills the whisper/ffmpeg child (via
  // cancel_import) and aborts the LLM stream (saving partial as paused).
  const onReanalyzeForeground = async () => {
    if (!videoId || reanalyzeBusy) return;
    const ok = await confirmDialog(
      "重新解析会用 whisper 重新转写、并重新调用大模型分析，覆盖当前的字幕与翻译。\n\n在本页前台进行——若中途离开本页，转写/解析会被停止。确定继续？",
      { title: "重新解析", okText: "继续", danger: true },
    );
    if (!ok) return;
    void onRetranscribe();
  };

  // Background variant of 重新解析: fire the whisper + LLM re-run into the
  // background queue and leave the page. The run is owned by
  // backgroundAnalyses (not this component), so it survives navigation and
  // flips the library status to ready when done. Progress shows in the
  // bottom-right 「后台任务」 widget.
  const onReanalyzeBackground = async () => {
    if (!videoId || reanalyzeBusy) return;
    const ok = await confirmDialog(
      "重新解析会用 whisper 重新转写、并重新调用大模型分析，覆盖当前的字幕与翻译。\n\n将在后台进行（你可以离开此页面，进度见右下角「后台任务」）。确定继续？",
      { title: "重新解析", okText: "继续" },
    );
    if (!ok) return;
    abortRef.current?.abort();
    await analysisRunRef.current?.catch(() => {});
    const oldSession = sessionRef.current;
    sessionRef.current = null;
    await oldSession?.close().catch(() => {});
    const e = library.videos.find((v) => v.id === videoId);
    retranscribeAndAnalyzeInBackground({
      videoId,
      label: e?.title ?? videoId,
      style: e?.analysisStyle ?? "colloquial",
      whisperModel: settings.whisperModel,
    });
    // The BG job now owns this video's re-analysis; release the foreground
    // store and return to Library.
    useAnalysis.getState().reset();
    navigate("/library");
  };

  useEffect(() => {
    if (!videoId) return;
    // StrictMode in dev double-mounts components. The pre-LLM phase still
    // needs `cancelled` so we don't transition phases after unmount; the
    // LLM call itself is aborted via abortRef in the cleanup.
    let cancelled = false;

    // Synchronously clear any state left over from the previous video so the
    // SubtitleList doesn't briefly render the old video's cues during the
    // async load below. Reset is a no-op if the store is already empty.
    if (useAnalysis.getState().videoId !== videoId) {
      useAnalysis.getState().reset();
      cuesRef.current = null;
    }

    (async () => {
      const reclaimed = await takeOverBackground(videoId);
      if (cancelled) {
        await reclaimed?.session.close().catch(() => {});
        return;
      }
      if (reclaimed) {
        cuesRef.current = reclaimed.cues;
        sessionRef.current = reclaimed.session;
        analysis.startFor(videoId);
        analysis.setCommittedAnalysis(reclaimed.analysis, reclaimed.cues.length);
        analysis.setAnalysisPreview(
          reclaimed.analysis,
          reclaimed.inflightPreview,
          reclaimed.cues.length,
        );
        if (reclaimed.analysis.checkpoint.phase === "complete") {
          analysis.setPhase("complete", 100);
        } else if (reclaimed.errorMessage) {
          analysis.setError(
            reclaimed.errorMessage,
            false,
            "analysis",
            reclaimed.quotaError,
          );
        } else {
          startAnalysis();
        }
        return;
      }

      let stored;
      try {
        stored = await openStoredAnalysisSession(videoId, {
          style: entry?.analysisStyle ?? "colloquial",
        });
      } catch (error) {
        if (!cancelled) {
          analysis.setError(
            error instanceof Error ? error.message : String(error),
            false,
            "analysis",
          );
        }
        return;
      }
      if (cancelled) {
        await stored?.session.close().catch(() => {});
        return;
      }
      if (!stored) {
        const cached = await invoke<AnalysisResult | null>("load_analysis", { videoId });
        if (cancelled) return;
        if (cached) {
          analysis.startFor(videoId);
          analysis.setSubtitles(cached.subtitles);
          const { subtitles: _drop, ...summary } = cached;
          analysis.setSummary(summary);
          analysis.setPhase("complete");
        } else {
          analysis.setError(
            "找不到 transcript.srt — 请重新转录",
            false,
            "transcription",
          );
        }
        return;
      }

      const { cues, session } = stored;
      cuesRef.current = cues;
      sessionRef.current = session;
      analysis.startFor(videoId);
      analysis.setCommittedAnalysis(session.analysis, cues.length);
      analysis.setAnalysisPreview(
        session.analysis,
        session.inflight ? analysisPreviewFromJournal(session.inflight) : null,
        cues.length,
      );

      if (session.analysis.checkpoint.phase === "complete") {
        analysis.setPhase("complete", 100);
        const cur = useLibrary
          .getState()
          .library.videos.find((video) => video.id === videoId);
        if (cur && cur.status !== "ready") {
          await invoke("library_set_status", {
            id: videoId,
            status: "ready",
            error: null,
          });
          await useLibrary.getState().reload();
        }
        return;
      }

      const checkpoint = session.analysis.checkpoint;
      if (checkpoint.nextCueOffset > 0 || checkpoint.phase === "summary") {
        analysis.setPhase("paused");
      } else {
        startAnalysis();
      }
    })();

    return () => {
      cancelled = true;
      retranscribeEpochRef.current += 1;
      // Abort the current model request, retain its durable inflight journal,
      // then release this producer lease.
      abortRef.current?.abort();
      abortRef.current = null;
      const session = sessionRef.current;
      if (session && cuesRef.current) {
        restoreForegroundDurablePreview(videoId, session, cuesRef.current.length);
      }
      sessionRef.current = null;
      void session?.close().catch(() => {});
      // If we're leaving mid-run, transition the store to "paused" so the
      // Library card stops claiming the video is actively analyzing —
      // nothing's running anymore, the user just paused by navigating
      // away. Skip when the phase is already terminal (complete / error)
      // since those reflect a real outcome we shouldn't overwrite.
      const cur = useAnalysis.getState();
      const ACTIVE = new Set(["downloading", "extracting", "transcribing", "analyzing"]);
      // Foreground re-analyze: if whisper/ffmpeg is mid-flight when the user
      // leaves the page, kill the child process — foreground analysis is tied
      // to this view. After retranscribe_video returns it unregisters its
      // cancel token, so this is a harmless no-op during the internal
      // reloadKey re-run that follows a successful transcribe.
      if (
        cur.videoId === videoId &&
        (cur.phase === "extracting" || cur.phase === "transcribing")
      ) {
        void invoke("cancel_import", { videoId }).catch(() => {});
      }
      if (cur.videoId === videoId && ACTIVE.has(cur.phase)) {
        useAnalysis.setState({ phase: "paused" });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, reloadKey]);

  const currentIdx = useVideoSync(videoRef, analysis.subtitles);

  // Bridge: expose active video to the AI Agent's ContextBuilder without
  // coupling Player.tsx internals to the agent module. setActive on mount,
  // clear on unmount.
  useEffect(() => {
    if (videoId && entry?.title) {
      usePlayerState.getState().setActive({ videoId, videoTitle: entry.title });
    }
    return () => usePlayerState.getState().clear();
  }, [videoId, entry?.title]);

  // Bridge: register a seek callback on mount so the AI Agent's
  // seek_to_time / jump_to_cue tools can drive playback without importing
  // Player.tsx internals. Empty deps — videoRef is captured via closure
  // and points to the same element for the lifetime of this mount.
  useEffect(() => {
    usePlayerState.getState().setSeekHandler((sec) => {
      if (videoRef.current) videoRef.current.currentTime = sec;
    });
    // Play a single cue's range, then auto-pause. Used by 精讲 step 1 to
    // replay one sentence's audio while the lesson overlay covers the video.
    // `rangeStopCleanup` removes the in-flight stop listener so a later
    // pause/replay can't leave a stale listener that pauses the next cue early.
    let rangeStopCleanup: (() => void) | null = null;
    usePlayerState.getState().setPlayRangeHandler((start, end) => {
      const v = videoRef.current;
      if (!v) return;
      rangeStopCleanup?.();
      v.currentTime = start;
      const stopAt = end > start ? end : start + 5;
      const onTime = () => {
        if (v.currentTime >= stopAt) {
          v.pause();
          rangeStopCleanup?.();
        }
      };
      rangeStopCleanup = () => {
        v.removeEventListener("timeupdate", onTime);
        rangeStopCleanup = null;
      };
      v.addEventListener("timeupdate", onTime);
      void v.play().catch(() => rangeStopCleanup?.());
    });
    // Pause / resume — voice mode pauses the video during the AI conversation
    // and resumes it on close; 精讲 pauses when leaving the "listen" step so the
    // cue doesn't talk over the tutor's TTS. Pausing also cancels any in-flight
    // range playback.
    usePlayerState.getState().setPauseHandler(() => {
      const v = videoRef.current;
      if (!v) return false;
      rangeStopCleanup?.();
      const wasPlaying = !v.paused;
      v.pause();
      return wasPlaying;
    });
    usePlayerState.getState().setPlayHandler(() => {
      void videoRef.current?.play().catch(() => {});
    });
    return () => {
      usePlayerState.getState().setSeekHandler(null);
      usePlayerState.getState().setPlayRangeHandler(null);
      usePlayerState.getState().setPauseHandler(null);
      usePlayerState.getState().setPlayHandler(null);
    };
  }, []);

  // Throttle currentIdx + currentTime writes to 500ms (spec §7.4) — useVideoSync
  // updates every frame; pushing each tick into zustand would thrash subscribers.
  useEffect(() => {
    const interval = setInterval(() => {
      usePlayerState.getState().setCue({
        currentIdx: currentIdx >= 0 ? currentIdx : null,
        currentTime: videoRef.current?.currentTime ?? null,
      });
    }, 500);
    return () => clearInterval(interval);
  }, [currentIdx]);

  // Map of vocab entries saved from the CURRENT video, keyed by lowercased+
  // trimmed expression (= VocabEntry.id). Used by SubtitleList to render
  // thin-yellow vocab highlights with hover tooltips on already-saved words.
  // Recomputed when entries / videoId / draftVersion change.
  //
  // Drafts: also included with `saved: false` so the subtitle list shows
  // a DASHED underline for phrases the user typed notes on but never
  // explicitly saved. Drafts live in localStorage (vocabDraft store);
  // localStorage doesn't fire change events for same-tab mutations, so
  // we subscribe to the store's own pub/sub via `subscribeDrafts` and
  // bump a `draftVersion` counter — that bump invalidates this useMemo
  // and re-pulls the latest drafts. Without the subscription the dashed
  // underline would never appear until the next render triggered by an
  // unrelated state change. If a phrase exists in BOTH the saved
  // entries and the draft store (rare race), saved wins.
  const [draftVersion, setDraftVersion] = useState(0);
  useEffect(() => {
    return subscribeDrafts(() => setDraftVersion((v) => v + 1));
  }, []);
  const vocabMapForVideo = useMemo(() => {
    const m = new Map<
      string,
      { meaningZh: string; usage: string; saved: boolean }
    >();
    for (const d of loadAllDrafts()) {
      if (d.videoId !== videoId) continue;
      m.set(makeVocabId(d.expression), {
        meaningZh: d.meaningZh,
        usage: d.usage,
        saved: false,
      });
    }
    for (const e of vocab.entries) {
      if (e.videoId === videoId) {
        m.set(e.id, { meaningZh: e.meaningZh, usage: e.usage, saved: true });
      }
    }
    return m;
  }, [vocab.entries, videoId, draftVersion]);

  function jump(t: number) {
    if (videoRef.current) videoRef.current.currentTime = t;
  }

  const baseName = sanitizeFilename(entry?.title ?? videoId ?? "subtitle");

  async function exportOne(lang: "en" | "zh") {
    const subs = analysis.subtitles;
    if (subs.length === 0) return;
    const suffix = lang === "en" ? ".en.srt" : ".zh.srt";
    const path = await save({
      defaultPath: `${baseName}${suffix}`,
      filters: [{ name: "SubRip Subtitle", extensions: ["srt"] }],
    });
    if (!path) return;
    const content = subtitlesToSrt(subs, lang);
    try {
      await invoke("write_text_file", { path, content });
    } catch (e) {
      void notify(`导出失败：${e}`);
    }
  }

  async function exportBoth() {
    const subs = analysis.subtitles;
    if (subs.length === 0) return;
    const dir = await open({ directory: true, multiple: false });
    if (!dir || typeof dir !== "string") return;
    const sep = dir.includes("\\") ? "\\" : "/";
    try {
      await invoke("write_text_file", {
        path: `${dir}${sep}${baseName}.en.srt`,
        content: subtitlesToSrt(subs, "en"),
      });
      await invoke("write_text_file", {
        path: `${dir}${sep}${baseName}.zh.srt`,
        content: subtitlesToSrt(subs, "zh"),
      });
    } catch (e) {
      void notify(`导出失败：${e}`);
    }
  }

  const canExport = analysis.subtitles.length > 0;
  // Pipeline is mid-flight — disable re-analyze so the user can't stack a
  // second whisper+LLM run on top of a running one.
  const reanalyzeBusy = ["downloading", "extracting", "transcribing", "analyzing"].includes(
    analysis.phase,
  );

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
        <button
          type="button"
          ref={reanalyzeButtonRef}
          disabled={reanalyzeBusy}
          onClick={(e) => {
            if (reanalyzeMenu) {
              setReanalyzeMenu(null);
              return;
            }
            const r = e.currentTarget.getBoundingClientRect();
            setReanalyzeMenu({ x: r.right - 200, y: r.bottom + 4 });
          }}
          title="重新解析（whisper + AI，覆盖现有字幕和翻译）"
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-400"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <button
          type="button"
          disabled={tutorPreparing || analysis.subtitles.length === 0}
          onClick={async () => {
            if (!videoId) return;
            // Pause the video the moment 精讲 starts — it shouldn't keep
            // playing behind the lesson overlay (during plan generation, the
            // pre-class screen, and the tutor's spoken steps).
            usePlayerState.getState().pauseHandler?.();
            setTutorPreparing(true);
            try {
              const currentSettings = useSettings.getState().settings;
              const subs = useAnalysis.getState().subtitles;
              const profile = await loadLearnerProfile();
              const plan = await planLesson({
                videoId,
                analysis: subs,
                profile,
                settings: currentSettings,
              });
              if (plan) {
                useTutorRuntime.getState().setMode({
                  kind: "lesson-preclass",
                  videoId,
                  plan,
                });
              } else {
                await notify("生成精讲计划失败，请检查 LLM 配置后重试。");
              }
            } catch (e) {
              await notify(`精讲计划生成出错：${String(e)}`);
            } finally {
              setTutorPreparing(false);
            }
          }}
          title={analysis.subtitles.length === 0 ? "字幕分析完成后可开始精讲" : "精讲这个视频"}
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-400"
        >
          <LessonIcon className={`h-[18px] w-[18px] ${tutorPreparing ? "animate-pulse" : ""}`} />
        </button>
        <button
          type="button"
          disabled={tutorPreparing || analysis.subtitles.length === 0}
          onClick={() => {
            if (!videoId) return;
            // Direct roleplay entry — no longer gated behind finishing a 精讲.
            // Pause the video (the picker + voice-conversation overlay covers
            // it) and open the picker in its loading state; RoleplayPickerHost
            // in the tutor portal derives the scenarios (the same shared path
            // the lesson-end and report「再来一个」buttons use).
            usePlayerState.getState().pauseHandler?.();
            useTutorRuntime.getState().setMode({
              kind: "roleplay-picker",
              scenarios: [],
              sourceVideoId: videoId,
              loading: true,
            });
          }}
          title={analysis.subtitles.length === 0 ? "字幕分析完成后可开始角色扮演" : "和这个视频角色扮演"}
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-400"
        >
          <RoleplayIcon className="h-5 w-5" />
        </button>
        <button
          type="button"
          ref={exportButtonRef}
          disabled={!canExport}
          onClick={(e) => {
            if (exportMenu) {
              setExportMenu(null);
              return;
            }
            const r = e.currentTarget.getBoundingClientRect();
            setExportMenu({ x: r.right - 200, y: r.bottom + 4 });
          }}
          title={canExport ? "导出字幕或视频" : "字幕分析完成后可导出"}
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-400"
        >
          <FileOutput className="h-4 w-4" />
        </button>
      </header>

      <ProgressBanner
        onStop={onStop}
        onContinue={onContinue}
        onRetranscribe={onRetranscribe}
        onMoveToBackground={onMoveToBackground}
      />

      <TinyModelHint hasSubtitles={analysis.subtitles.length > 0} />

      {videoId && (
        <div className="px-4 pt-2">
          <LessonResumeBanner
            videoId={videoId}
            onResume={(state) => {
              // TutorPortalRoot will build the LessonRuntime from resumeFrom
              // when it handles the lesson-in-progress mode.
              useTutorRuntime.getState().setMode({
                kind: "lesson-in-progress",
                videoId,
                resumeFrom: state,
              });
            }}
          />
        </div>
      )}

      <div ref={splitContainerRef} className="flex-1 flex min-h-0">
        <div
          style={{ width: panelOpen ? `${splitPct}%` : "100%" }}
          className={
            "shrink-0 " +
            (splitDragging ? "" : "transition-[width] duration-300 ease-out")
          }
        >
          {videoSrc && (
            <VideoPlayer
              ref={videoRef}
              src={videoSrc}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen((v) => !v)}
              currentSubtitle={
                currentIdx >= 0 ? analysis.subtitles[currentIdx] ?? null : null
              }
              showCaptions={showCaptions}
              onToggleCaptions={() => setShowCaptions((v) => !v)}
              captionStyle={captionStyle}
              onChangeCaptionStyle={onChangeCaptionStyle}
            />
          )}
        </div>
        <div
          onMouseDown={panelOpen ? startSplitDrag : undefined}
          onDoubleClick={panelOpen ? () => setSplitPct(58) : undefined}
          title={panelOpen ? "拖动调整比例 · 双击重置 58%" : undefined}
          style={{ width: panelOpen ? "4px" : "0px" }}
          className={
            "shrink-0 overflow-hidden bg-zinc-800 " +
            (panelOpen ? "hover:bg-blue-400 active:bg-blue-500 cursor-col-resize " : "pointer-events-none ") +
            (splitDragging ? "" : "transition-[width,background-color] duration-300 ease-out")
          }
        />
        <div
          style={{
            width: panelOpen ? `calc(${100 - splitPct}% - 4px)` : "0px",
          }}
          className={
            "shrink-0 overflow-hidden flex flex-col min-h-0 " +
            (splitDragging ? "" : "transition-[width] duration-300 ease-out")
          }
        >
          <div className="flex border-b border-zinc-800 text-sm items-center">
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
            {tab === "subtitles" && (
              <div className="ml-auto mr-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAutoScrollSubtitle((v) => !v)}
                  title={
                    autoScrollSubtitle
                      ? "已开启：字幕会跟随播放进度自动滚动"
                      : "已关闭：字幕不会自动滚动"
                  }
                  className={
                    "text-xs px-2 py-1 rounded border transition-colors " +
                    (autoScrollSubtitle
                      ? "border-blue-500/50 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20"
                      : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")
                  }
                >
                  <span className="inline-flex items-center gap-1">
                    <AutoScrollIcon className="h-3 w-3" />
                    自动跳转：{autoScrollSubtitle ? "开" : "关"}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={!subtitleEditingAllowed}
                  onClick={() => setEditingSubtitle((v) => !v)}
                  title={
                    !subtitleEditingAllowed
                      ? "AI 正在解析并保存字幕，完成或暂停后可编辑"
                      : editingSubtitle
                      ? "退出编辑模式"
                      : "进入编辑模式：修改文本、时间戳、增删、拖拽排序"
                  }
                  className={
                    "text-xs px-2 py-1 rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
                    (editingSubtitle
                      ? "border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                      : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")
                  }
                >
                  ✎ 编辑：{editingSubtitle ? "开" : "关"}
                </button>
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0">
            {tab === "subtitles" && (
              <SubtitleList
                subtitles={analysis.subtitles}
                currentIdx={currentIdx}
                onJump={jump}
                autoScroll={autoScrollSubtitle}
                editing={editingSubtitle && subtitleEditingAllowed}
                onChanged={persistManualEdits}
                vocabMap={vocabMapForVideo}
                videoId={videoId ?? ""}
                videoTitle={entry?.title ?? videoId ?? ""}
              />
            )}
            {tab === "keyPhrases" && (
              <KeyPhraseList
                phrases={analysis.summary?.keyPhrases ?? []}
                subtitles={analysis.subtitles}
                videoId={videoId ?? ""}
                videoTitle={entry?.title ?? videoId ?? ""}
              />
            )}
          </div>
        </div>
      </div>

      {reanalyzeMenu && (
        <ContextMenu
          x={reanalyzeMenu.x}
          y={reanalyzeMenu.y}
          onClose={() => setReanalyzeMenu(null)}
          anchorRef={reanalyzeButtonRef}
          items={[
            { label: "前台解析（留在本页，离开即停止）", onClick: onReanalyzeForeground },
            { label: "后台解析（返回库，后台进行）", onClick: onReanalyzeBackground },
          ]}
        />
      )}

      {exportMenu && (
        <ContextMenu
          x={exportMenu.x}
          y={exportMenu.y}
          onClose={() => setExportMenu(null)}
          anchorRef={exportButtonRef}
          items={[
            { label: "导出英文字幕 (.en.srt)", onClick: () => void exportOne("en") },
            { label: "导出中文字幕 (.zh.srt)", onClick: () => void exportOne("zh") },
            { label: "同时导出两个 SRT…", onClick: () => void exportBoth() },
            {
              label: "导出带字幕视频 (.mp4)…",
              onClick: () => setShowExportVideo(true),
            },
          ]}
        />
      )}

      {showExportVideo && videoId && (
        <ExportVideoModal
          videoId={videoId}
          videoTitle={entry?.title ?? videoId}
          subtitles={analysis.subtitles}
          durationSec={
            (entry?.durationSec ?? 0) > 0
              ? entry!.durationSec
              : analysis.subtitles.length > 0
              ? analysis.subtitles[analysis.subtitles.length - 1].endTime
              : 0
          }
          onClose={() => setShowExportVideo(false)}
        />
      )}

      {/* 精讲: loading overlay while the lesson plan is generated (LLM call). */}
      {tutorPreparing && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-9 py-7 shadow-2xl animate-agent-popover-in">
            <Loader2 className="h-7 w-7 animate-spin text-blue-400" />
            <div className="text-sm text-zinc-300">正在生成精讲计划…</div>
            <div className="max-w-[220px] text-center text-xs leading-relaxed text-zinc-500">
              正在读取 {analysis.subtitles.length} 句字幕、结合你的薄弱点规划重点。视频较长时需要等十几秒。
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
