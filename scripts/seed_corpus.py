"""Bootstrap the whatsub shared corpus from the desktop pipeline's analyzed videos.

Reads:  data/videos/{scene}/{video_id}/{video_id}.analysis.json
Writes: POST https://whatsub.eversay.cc/api/corpus/contribute (one per highlightWord)
        + a final POST /api/corpus/admin/seed-tags backfilling tags.scene from the
          directory layout (avoids running the LLM classifier on data we already know).

Idempotency: re-running is safe at the phrase level — corpus_phrases UPSERTs on
phrase_normalized. corpus_contributions DOES gain duplicate rows on re-run; the
curator contributor_id keeps these out of the plugin's lookup card by default
(excludeContributor) and a cleanup query is documented in the README for callers
that want a hard reset.

Usage:
    PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \\
      python scripts/seed_corpus.py \\
        --endpoint https://whatsub.eversay.cc \\
        --data-root data/videos \\
        --admin-token "$WHATSUB_ADMIN_TOKEN" \\
        --dry-run   # validates inputs without POSTing
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterator, Optional

CURATOR_ID = "whatsub-curator"


def iter_analysis_files(data_root: Path) -> Iterator[tuple[str, Path]]:
    """Yields (scene, analysis_json_path) for every analysis.json under data_root.

    Layout assumed: data_root / scene / video_id / video_id.analysis.json.
    Anything that doesn't match (loose files, README, etc.) is silently skipped.
    """
    if not data_root.exists() or not data_root.is_dir():
        return
    for scene_dir in sorted(data_root.iterdir()):
        if not scene_dir.is_dir():
            continue
        for video_dir in sorted(scene_dir.iterdir()):
            if not video_dir.is_dir():
                continue
            video_id = video_dir.name
            analysis = video_dir / f"{video_id}.analysis.json"
            if analysis.exists():
                yield scene_dir.name, analysis


def extract_contributions(analysis_path: Path, scene: str) -> list[dict]:
    """Reads an analysis.json and returns a list of /contribute body payloads.

    One payload per (cue, highlightWord). Cues without highlightWords or text
    are skipped. The internal `_scene` field is carried through for the
    post-import sidecar; `post_contribute` strips it before sending.
    """
    with analysis_path.open(encoding="utf-8") as f:
        data = json.load(f)
    # analysis.json filename is "<video_id>.analysis.json"; Path.stem drops one
    # suffix, so we strip the remaining ".analysis" manually.
    video_id = analysis_path.stem
    if video_id.endswith(".analysis"):
        video_id = video_id[: -len(".analysis")]
    video_title = data.get("title", "") or ""
    subtitles = data.get("subtitles", []) or []

    out: list[dict] = []
    for cue in subtitles:
        words = cue.get("highlightWords") or []
        text = (cue.get("text") or "").strip()
        cue_time = cue.get("time", 0) or 0
        if not words or not text:
            continue
        # canonicalizeUrl on the server normalizes any YT variant to this exact form;
        # send the canonical form directly so dedup hits regardless of server logic.
        url = f"https://youtu.be/{video_id}?t={int(cue_time)}"
        for word in words:
            if not isinstance(word, str) or not word.strip():
                continue
            out.append(
                {
                    "phraseRaw": word,
                    "contextSentence": text,
                    "source": {
                        "kind": "curator",
                        "url": url,
                        "title": video_title,
                        "timestampSec": int(cue_time),
                    },
                    "contributorId": CURATOR_ID,
                    # Internal-only field — stripped by post_contribute before sending.
                    "_scene": scene,
                }
            )
    return out


def post_contribute(
    endpoint: str, body: dict, timeout: int = 30
) -> tuple[int, Optional[dict]]:
    """POSTs one /api/corpus/contribute payload. Returns (status, body-or-None)."""
    raw_body = {k: v for k, v in body.items() if not k.startswith("_")}
    req = urllib.request.Request(
        url=f"{endpoint.rstrip('/')}/api/corpus/contribute",
        data=json.dumps(raw_body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            # Server's CORS check requires an Origin for cross-origin contexts;
            # we're a CLI but pin a stable identifier so server logs are
            # interpretable. Server doesn't actually gate by origin (auth is
            # contributorId), so this is just for ops visibility.
            "Origin": "https://whatsub.eversay.cc",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None


def post_scene_sidecar(
    endpoint: str,
    phrases_with_scene: list[tuple[str, str]],
    admin_token: str,
    timeout: int = 60,
) -> int:
    """One-shot admin endpoint backfilling tags.scene for curator-seeded phrases.

    Returns the response status. Raises on non-2xx so callers can fail loud
    when the token is wrong or the endpoint isn't reachable.
    """
    req = urllib.request.Request(
        url=f"{endpoint.rstrip('/')}/api/corpus/admin/seed-tags",
        data=json.dumps(
            {
                "phrases": [
                    {"phraseRaw": p, "scene": s} for p, s in phrases_with_scene
                ]
            }
        ).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {admin_token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status


def dedup_phrase_scenes(payloads: list[dict]) -> list[tuple[str, str]]:
    """Reduce payloads to (phraseRaw, scene) uniques by lowercased phrase.

    The server's seed-tags route normalizes again before the UPDATE, so
    duplicate phraseRaw with same scene is just wasted work. We dedupe on the
    plugin's phraseRaw.lower().strip() so the sidecar batch stays small.
    """
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for body in payloads:
        raw = body["phraseRaw"]
        scene = body["_scene"]
        key = raw.lower().strip()
        if key in seen:
            continue
        seen.add(key)
        out.append((raw, scene))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default="https://whatsub.eversay.cc")
    parser.add_argument("--data-root", type=Path, default=Path("data/videos"))
    parser.add_argument(
        "--admin-token",
        default=None,
        help="Token for /admin/seed-tags sidecar. If omitted, scene tags are NOT backfilled.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print payload counts without POSTing.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Stop after N contributions (0 = no limit). Debugging aid.",
    )
    parser.add_argument(
        "--pace-ms",
        type=int,
        default=10,
        help="Delay between contribute POSTs in ms. Polite pacing — curator bypasses "
        "rate limit but we don't want to thrash the DB.",
    )
    args = parser.parse_args()

    if not args.data_root.exists():
        print(f"[seed] data root not found: {args.data_root}", file=sys.stderr)
        return 1

    total_payloads: list[dict] = []
    for scene, path in iter_analysis_files(args.data_root):
        total_payloads.extend(extract_contributions(path, scene))
    if args.limit > 0:
        total_payloads = total_payloads[: args.limit]

    unique_count = len({p["phraseRaw"].lower().strip() for p in total_payloads})
    print(
        f"[seed] {len(total_payloads)} contributions ready across {unique_count} unique phrases",
        flush=True,
    )
    if args.dry_run:
        return 0

    ok_count = 0
    fail_count = 0
    pace_s = args.pace_ms / 1000.0
    for i, body in enumerate(total_payloads):
        status, _ = post_contribute(args.endpoint, body)
        if status in (200, 201):
            ok_count += 1
        else:
            fail_count += 1
        if i > 0 and i % 100 == 0:
            print(
                f"[seed] {i}/{len(total_payloads)} ok={ok_count} fail={fail_count}",
                flush=True,
            )
        if pace_s > 0:
            time.sleep(pace_s)

    print(f"[seed] contribute done · ok={ok_count} fail={fail_count}", flush=True)

    if args.admin_token:
        pairs = dedup_phrase_scenes(total_payloads)
        print(f"[seed] applying scene sidecar for {len(pairs)} unique phrases…", flush=True)
        sidecar_status = post_scene_sidecar(args.endpoint, pairs, args.admin_token)
        print(f"[seed] sidecar tags applied: HTTP {sidecar_status}", flush=True)
    else:
        print(
            "[seed] --admin-token not provided; tags.scene NOT backfilled "
            "(LLM classifier will tag on first lookup)",
            flush=True,
        )

    return 0 if fail_count == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
