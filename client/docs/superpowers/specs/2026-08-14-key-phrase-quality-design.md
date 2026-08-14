# Key Phrase Quality and Annotation Repair Design

## Problem

Subtitle analysis currently accepts any highlight whose `source` is an exact
substring of the cue. The prompt limits each cue to two highlights, but it does
not limit the number of words in a highlight. Models such as Qwen can therefore
return most or all of a sentence as a “phrase”, and the client accepts it.

There is a second failure mode. A cue is considered resolved as soon as its
translation is valid. If the model returns malformed highlight fields, the
validator silently drops those fields and still commits the translated cue.
That cue is never requested again, leaving a translated subtitle with missing
learning annotations.

## Goals

- Prefer useful vocabulary, collocations, idioms, and phrasal verbs instead of
  complete sentences.
- Apply the same rules to every provider rather than special-casing Qwen.
- Preserve valid translations when only the highlight annotation is malformed.
- Repair only affected annotations and never restart an otherwise successful
  batch.
- Keep analysis bounded: malformed annotations must not cause infinite retries
  or make the whole video fail.

## Non-goals

- Rewriting translations that have already passed validation.
- Adding provider-specific prompt branches.
- Automatically truncating a long phrase, because truncation can change its
  meaning or produce an unnatural expression.
- Requiring every subtitle cue to contain a highlight.

## Phrase Rules

The system and summary prompts will use the same learning-expression rules:

- Prefer one to five English words.
- A genuine idiom, fixed expression, or phrasal pattern may contain up to eight
  words.
- Never return more than eight words.
- Do not select the entire cue when that cue contains more than five words.
- Greetings, fillers, function words, and generic sentence fragments are not
  key phrases.
- `isKeyPoint` must be `false` when a cue contains no useful highlight.

The local validator is the final safety boundary. It counts lexical English
tokens while treating contractions and hyphenated terms as one token. It drops
an expression when it contains more than eight tokens. It also drops an
expression equal to the complete normalized cue when the cue has more than five
tokens. It does not guess whether a six-to-eight-word expression is genuinely
fixed; the prompt makes that semantic decision and the validator only enforces
the hard maximum.

The global `keyPhrases` summary uses the same eight-token hard maximum and
deduplication rules. This prevents a model from producing short cue highlights
but turning them back into full sentences during summary generation.

## Canonical Streaming Format

The provider-facing format is reduced to three fields and remains JSON Lines so
the client can parse and preview each cue as soon as it arrives:

```json
{
  "i": 12,
  "zh": "我得补上进度",
  "p": [["catch up", "补上", "表示赶上进度或补做遗漏事项"]]
}
```

The tuple members are, in order, English source phrase, its exact Chinese
substring in `zh`, and a Chinese usage note. A cue without a useful phrase uses
`"p":[]`. The client derives `isKeyPoint` from whether at least one phrase
survives validation, so the model no longer returns a redundant boolean.

JSON Lines is retained instead of a Chinese heading/prose protocol because JSON
provides unambiguous field boundaries and string escaping while still allowing
one-cue-at-a-time streaming. The compact keys and positional phrase tuple remove
most repeated schema tokens without introducing fuzzy heading parsing.

## Compatibility Input Shapes

For compatibility with in-flight requests and models that occasionally follow
an older schema, the validator also accepts the current verbose shape:

```json
{
  "index": 12,
  "translation": "我得补上进度",
  "isKeyPoint": true,
  "highlights": [
    { "source": "catch up", "translation": "补上", "note": "……" }
  ]
}
```

It also accepts the previous legacy shape:

```json
{
  "highlightWords": ["catch up"],
  "keyNotes": { "catch up": "……" },
  "highlightTranslations": { "catch up": "补上" }
}
```

All three shapes are normalized into canonical highlight candidates before
normal validation. A candidate is retained only when all required strings
exist, the source is an exact substring of the authoritative cue text, the
translated phrase is an exact substring of the accepted translation, and the
phrase passes the length rules. Compatibility must never weaken validation.

## Validation Result

Cue validation will distinguish three outcomes:

1. **Unresolved translation** — index or translation is invalid. Existing cue
   repair behavior requests this cue again.
2. **Resolved cue** — translation is valid and the annotation is either valid or
   legitimately empty.
3. **Resolved translation, damaged annotation** — translation is valid, but the
   model claimed a key point or supplied annotation fields and none of those
   fields could be accepted.

The third result carries the authoritative source cue and accepted translation
forward without committing an invented phrase.

## Targeted Annotation Repair

After the ordinary cue batch is translated, cues in the third category are
sent through one targeted annotation-repair round:

- The request contains only damaged cue indexes, source text, and their already
  accepted translations.
- The model is explicitly told not to translate again and to return only `i`
  and compact `p` fields. The accepted `zh` is supplied by the client and is not
  regenerated.
- A repaired highlight must pass the same substring and length checks.
- Correct cues are never included in this request.
- If the repair response is still malformed, the client commits the preserved
  translation with `isKeyPoint=false` and empty annotations.
- A provider transport error uses the existing bounded analysis retry policy;
  malformed content receives only this single targeted repair round.

This preserves streaming progress and prevents one bad annotation from failing
or replaying a 50-cue batch.

## Summary Handling

The summary prompt repeats the phrase-length contract and returns one compact
line using the same phrase tuples:

```json
{"p":[["catch up","补上","用于表示赶上进度或补做遗漏事项"]]}
```

Parsed summary entries are filtered locally:

- required string fields must remain present;
- expressions over eight lexical tokens are dropped;
- expressions are deduplicated case-insensitively after trimming.

If all summary entries are removed, the summary is still valid with an empty
list. Subtitle translations and cue highlights remain available to the user.

## Testing

Tests will cover:

- prompt language for one-to-five-word preference and eight-word maximum;
- prompt language and parsing for the compact `i` / `zh` / `p` JSONL contract;
- normal short highlights being retained;
- eight-word fixed expressions being retained;
- nine-word highlights being rejected;
- a long whole-cue highlight being rejected;
- a short whole-cue expression being allowed;
- both verbose compatibility formats being normalized safely;
- malformed annotation returning the damaged-annotation state while preserving
  translation;
- targeted repair requesting only damaged cues and not translating them again;
- failed targeted repair degrading to translation-only output;
- summary filtering and case-insensitive deduplication;
- unchanged behavior for already-valid OpenAI-compatible, Claude, and Gemini
  responses.

## Success Criteria

- Qwen cannot commit a sentence longer than eight words as a key phrase.
- Existing valid short phrases continue to appear and remain clickable.
- Legacy but structurally complete highlight output can still be recovered.
- A highlight-format error does not discard a valid translation, replay the
  whole batch, or fail the video analysis.
- All providers share one prompt and one local validation path.
