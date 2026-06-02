// src/lib/api/corpus.ts
//
// Personal-corpus contribute API (desktop). Mirrors quota.ts: the session
// bearer comes from the Rust store via get_session_token; the body matches the
// backend's CorpusContributeRequest exactly (same fields the plugin's 划词 flow
// sends). POST /api/corpus/contribute.

import { invoke } from "@tauri-apps/api/core";

const BASE = "https://whatsub.eversay.cc/api";
const TIMEOUT_MS = 20_000;

export interface CorpusSource {
  kind: "youtube" | "webpage" | "pdf";
  url: string;
  title?: string;
  /** YouTube only — seconds into the video. */
  timestampSec?: number;
}

export interface CorpusContributeBody {
  /** The phrase/expression text (required, non-empty). */
  phraseRaw: string;
  /** Full sentence context the phrase appeared in (required). */
  contextSentence: string;
  source: CorpusSource;
  meaningZh?: string;
  usageNote?: string;
  /** Tag strings (scene keys or custom). */
  tags?: string[];
}

export interface CorpusContributeResult {
  id: number;
}

/** Thrown on a non-OK response; `.reason` is the backend code (e.g.
 *  "quota_exceeded", "empty_phrase") so callers can branch. */
export class CorpusContributeError extends Error {
  reason: string;
  used?: number;
  limit?: number;
  constructor(reason: string, used?: number, limit?: number) {
    super(reason);
    this.reason = reason;
    this.used = used;
    this.limit = limit;
  }
}

export async function corpusContribute(
  body: CorpusContributeBody,
): Promise<CorpusContributeResult> {
  const token = await invoke<string | null>("get_session_token");
  if (!token) throw new CorpusContributeError("auth_required");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}/corpus/contribute`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      // Backend error shape: { reason, used?, limit?, window? }
      const j = (await resp.json().catch(() => null)) as
        | { reason?: string; used?: number; limit?: number }
        | null;
      throw new CorpusContributeError(
        j?.reason ?? `http_${resp.status}`,
        j?.used,
        j?.limit,
      );
    }
    return resp.json() as Promise<CorpusContributeResult>;
  } finally {
    clearTimeout(timer);
  }
}
