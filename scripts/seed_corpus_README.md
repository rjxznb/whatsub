# scripts/seed_corpus.py

Bootstraps the whatsub shared corpus on `whatsub-license` by walking
`data/videos/{scene}/{video_id}/{video_id}.analysis.json` and POSTing every
`highlightWord` as a curator-attributed contribution.

## Prereqs

- Python 3.9+ (stdlib only — no extra deps)
- Backend deployed at the endpoint URL (default `https://whatsub.eversay.cc`)
- `WHATSUB_ADMIN_TOKEN` for the optional scene-tags sidecar

## Run

```bash
# Dry-run first to see counts
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python scripts/seed_corpus.py --dry-run

# Real run: ~10ms pacing per request → ~30-60 min for 100k contributions
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python scripts/seed_corpus.py \
    --admin-token "$WHATSUB_ADMIN_TOKEN"

# Debug subset (first 100 only)
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python scripts/seed_corpus.py \
    --limit 100 --admin-token "$WHATSUB_ADMIN_TOKEN"
```

## Tests

```bash
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python -m pytest scripts/seed_corpus_test.py -v
```

Covers iter + extract + dedup pure functions. HTTP transport
(`post_contribute`, `post_scene_sidecar`) is exercised by manual smoke
test against a live backend — wire it up once production is up.

## Idempotency

**Safe to re-run, with caveats:**

- `corpus_phrases` UPSERTs on `phrase_normalized`. Re-running bumps
  `contribution_count` (correct) and `last_seen_at` (also correct).
- `corpus_contributions` gains a *new* row per re-run since each is
  treated as a distinct save event. The curator `contributor_id`
  keeps these out of plugin lookup cards by default (the route's
  `excludeContributor` param defaults to the caller's own id).

For a hard reset before re-seeding:

```sql
DELETE FROM corpus_contributions WHERE contributor_id = 'whatsub-curator';
DELETE FROM corpus_phrases WHERE NOT EXISTS (
  SELECT 1 FROM corpus_contributions c
   WHERE c.phrase_normalized = corpus_phrases.phrase_normalized
);
```

## Expected output (rough)

Per the existing pipeline state:

- ~3–5 万 unique phrases across 18 scenes
- ~10–20 万 contribution rows
- 1–5k phrases per scene typically

Sidecar (`/admin/seed-tags`) backfills `tags.scene` for every unique
phrase. The LLM classifier (DeepSeek) would assign the same value
asynchronously on first plugin contribute, but the sidecar skips the
~$0.0001×N cost since scenes are already known from the directory layout.

## What this does NOT seed

- `tags.partOfSpeech` and `tags.cefrLevel` — these come from the LLM
  classifier on the first user contribute against each phrase. The
  curator path deliberately skips classification (spec §7.5).
- Any phrase the pipeline didn't generate `highlightWords` for. Run
  the pipeline first if coverage is incomplete; the seed reads what's
  on disk.
