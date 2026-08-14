# Highlight Phrase Card Actions Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep highlighted phrase cards interactive and add Chinese meaning, speech, and vocabulary save actions.

**Architecture:** Enrich `HighlightWord` with already-owned cue/video metadata from `SubtitleList`. Keep visibility local to the phrase/card wrapper and delegate speech/save to existing application components.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library.

---

## Task 1: Specify interactive card behavior

**Files:**
- Create: `src/components/HighlightWord.test.tsx`
- Modify: `src/components/HighlightWord.tsx`

- [ ] Write failing tests for Chinese meaning and explanation rendering, hover grace, speech, and save metadata.
- [ ] Run the focused test and confirm failures are caused by missing props/actions and trigger-only mouse leave.

## Task 2: Thread cue/video context and implement actions

**Files:**
- Modify: `src/components/HighlightWord.tsx`
- Modify: `src/components/SubtitleList.tsx`
- Modify: `src/components/SubtitleList.render.test.tsx`

- [ ] Add the minimum typed props needed by `StarButton` and TTS.
- [ ] Move enter/leave handling to the combined wrapper with a 150 ms close timer and cleanup.
- [ ] Render meaning, explanation, speech, and save controls; stop action clicks from seeking the subtitle row.
- [ ] Pass `highlightTranslations[word]`, note, cue time/text, video ID/title at the render site.

## Task 3: Verify

- [ ] Run focused HighlightWord and SubtitleList tests.
- [ ] Run `pnpm typecheck`.
- [ ] Run the full frontend Vitest suite.
- [ ] Inspect the diff for unrelated changes and commit the implementation.

