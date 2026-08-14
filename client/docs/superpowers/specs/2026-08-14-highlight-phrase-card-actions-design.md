# Highlight Phrase Card Actions Design

**Date:** 2026-08-14

## Goal

Make the highlighted learning-phrase card usable as an interactive surface instead of a disappearing tooltip. The card must show the phrase's Chinese meaning, retain the existing usage explanation, and expose speech and vocabulary-save actions.

## Interaction

- Hovering either the amber phrase or its card keeps the card open.
- Leaving the combined phrase/card region closes it after a short 150 ms grace period, allowing the pointer to cross the visual gap without flicker.
- Clicking the phrase continues to toggle the card for mouse/touch accessibility.
- Clicking speech or save does not trigger the subtitle row's seek action.

## Content and actions

The card displays:

1. The English phrase.
2. Its already-validated per-cue Chinese fragment from `highlightTranslations[word]`.
3. Its existing usage explanation from `keyNotes[word]`.
4. A speech button using the existing TTS hook.
5. The existing `StarButton`, using the Chinese fragment as `meaningZh`, the note as `usage`, and the current video/cue metadata as provenance.

No additional model request is made. The independent Key Phrases tab is unchanged because it already offers speech and save actions.

## Data flow

`SubtitleList` already owns `videoId`, `videoTitle`, and each cue. It passes `word`, `meaningZh`, `note`, cue time/text, and video metadata to `HighlightWord`. `HighlightWord` owns only card visibility and delegates persistence to `StarButton`.

## Testing

- The card renders the Chinese meaning and explanation.
- Moving from the trigger into the card keeps it visible beyond the close delay.
- Leaving the whole region closes it after the delay.
- Speech calls TTS with the English phrase.
- Save receives the exact meaning, explanation, video, and cue metadata.

