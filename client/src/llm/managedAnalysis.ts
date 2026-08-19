import { fetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import type { LibraryEntry } from "../types/library";
import type { TranslationStyle } from "../types/settings";
import type { CheckpointedAnalysis, KeyPhrase, SrtCue, Subtitle } from "./types";
import type { PersistedAnalysisSession } from "./analysisSession";
import { abortableDelay } from "./retry";

const BASE_URL = "https://whatsub.eversay.cc/api/library/mobile-analysis";
const POLL_MS = 2_000;

interface ManagedJob {
  jobId: string;
  status: "queued" | "running" | "paused_quota" | "completed" | "failed" | "cancelled";
  completedCues: number;
  totalCues: number;
  errorCode: string | null;
}

interface ManagedResults {
  status: ManagedJob["status"];
  nextBatchCursor: number;
  batches: Array<{ batchIndex: number; subtitles: Subtitle[] }>;
  keyPhrases?: KeyPhrase[];
  errorCode: string | null;
}

export interface ManagedAnalysisOptions {
  entry: LibraryEntry;
  cues: readonly SrtCue[];
  style: TranslationStyle;
  session: PersistedAnalysisSession;
  signal?: AbortSignal;
  onCommitted?: (analysis: CheckpointedAnalysis) => void;
}

function asSrt(cues: readonly SrtCue[]): string {
  return cues.map((cue, index) => {
    const stamp = (seconds: number) => {
      const ms = Math.max(0, Math.round(seconds * 1000));
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const s = Math.floor((ms % 60_000) / 1000);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
    };
    return `${index + 1}\n${stamp(cue.time)} --> ${stamp(cue.endTime)}\n${cue.text}\n`;
  }).join("\n");
}

function youtubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const id = parsed.hostname === "youtu.be"
      ? parsed.pathname.slice(1).split("/")[0]
      : parsed.hostname.endsWith("youtube.com") ? parsed.searchParams.get("v") : null;
    return id && /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function authHeader(): Promise<string> {
  const session = await invoke<string | null>("get_session_token").catch(() => null);
  if (session) return `Bearer ${session}`;
  const trial = await invoke<{ trialToken?: string } | null>("trial_read_state").catch(() => null);
  return `Bearer ${trial?.trialToken ?? ""}`;
}

async function request<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      authorization: await authHeader(),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal,
  });
  const body = await response.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(body); } catch { /* preserve the HTTP status below */ }
  if (!response.ok) {
    const code = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error) : `HTTP ${response.status}`;
    throw new Error(`托管解析失败：${code}`);
  }
  return parsed as T;
}

function mergeSubtitleBatch(
  current: CheckpointedAnalysis,
  subtitles: Subtitle[],
  keyPhrases: KeyPhrase[] | undefined,
  totalCues: number,
): CheckpointedAnalysis {
  const nextOffset = current.subtitles.length + subtitles.length;
  return {
    subtitles: [...current.subtitles, ...subtitles],
    keyPhrases: keyPhrases ?? current.keyPhrases,
    checkpoint: {
      ...current.checkpoint,
      nextCueOffset: nextOffset,
      phase: nextOffset >= totalCues ? "summary" : "cues",
      revision: current.checkpoint.revision + 1,
    },
  };
}

export async function executeManagedAnalysis(options: ManagedAnalysisOptions): Promise<CheckpointedAnalysis> {
  if (!Number.isInteger(options.entry.durationSec) || options.entry.durationSec <= 0) {
    throw new Error("无法确认视频时长，暂时不能提交托管解析");
  }
  const sourceUrl = options.entry.source.type === "url" ? options.entry.source.url : "";
  const id = youtubeId(sourceUrl) ?? "";

  const job = await request<ManagedJob>("/jobs", {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: `desktop:${options.entry.id}:${options.session.transcriptGeneration}`,
      youtubeId: id,
      sourceUrl,
      title: options.entry.title,
      durationSec: Math.round(options.entry.durationSec),
      cues: options.cues,
      transcriptSrt: asSrt(options.cues),
      persistLibraryEntry: false,
    }),
  }, options.signal);

  let current = options.session.analysis;
  let cursor = -1;
  let active = job;
  let resumeCount = 0;
  while (true) {
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const page = await request<ManagedResults>(
      `/jobs/${encodeURIComponent(active.jobId)}/results?afterBatch=${cursor}`,
      { method: "GET" },
      options.signal,
    );
    for (const batch of page.batches) {
      const expectedStart = current.subtitles.length;
      const submittedStart = batch.batchIndex * 50;
      if (submittedStart !== expectedStart) {
        throw new Error("托管解析任务与本地进度不一致，请从头重新解析");
      }
      current = await options.session.save(mergeSubtitleBatch(
        current,
        batch.subtitles,
        page.keyPhrases,
        options.cues.length,
      ));
      options.onCommitted?.(current);
      cursor = batch.batchIndex;
    }
    active = await request<ManagedJob>(
      `/jobs/${encodeURIComponent(active.jobId)}`,
      { method: "GET" },
      options.signal,
    );
    if (active.status === "failed" || active.status === "paused_quota" || active.status === "cancelled") {
      if (active.status === "failed" && [
        "upstream_unavailable",
        "invalid_analysis_cue",
        "invalid_sse",
      ].includes(active.errorCode ?? "") && resumeCount < 2) {
        resumeCount += 1;
        active = await request<ManagedJob>(
          `/jobs/${encodeURIComponent(active.jobId)}/resume`,
          { method: "POST", body: "{}" },
          options.signal,
        );
        continue;
      }
      throw new Error(`托管解析未完成：${active.errorCode ?? active.status}`);
    }
    if (active.status === "completed") {
      const completed: CheckpointedAnalysis = {
        ...current,
        keyPhrases: page.keyPhrases ?? current.keyPhrases,
        checkpoint: {
          ...current.checkpoint,
          phase: "complete",
          nextCueOffset: options.cues.length,
          revision: current.checkpoint.revision + 1,
        },
      };
      return options.session.save(completed);
    }
    await abortableDelay(POLL_MS, options.signal);
  }
}
