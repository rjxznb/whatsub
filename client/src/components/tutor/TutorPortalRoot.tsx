import { useEffect, useRef, useState } from "react";
import { useTutorRuntime } from "../../store/tutorRuntime";
import { useSettings } from "../../store/settings";
import { useAnalysis } from "../../store/analysis";
import { usePlayerState } from "../../store/playerState";
import { useLearnerProfile, loadLearnerProfile } from "../../tutor/learnerProfile";
import { ttsCancel } from "../../tutor/tts";
import { LessonOverlay } from "./LessonOverlay";
import { LessonPreClass } from "./LessonPreClass";
import { LessonStepView } from "./LessonStepView";
import { LessonEnd } from "./LessonEnd";
import { RoleplayScenarioPicker } from "./RoleplayScenarioPicker";
import { RoleplayOverlay } from "./RoleplayOverlay";
import { RoleplayReport } from "./RoleplayReport";
import { RemediationOverlay } from "./RemediationOverlay";
import { LessonRuntime } from "../../tutor/lessonRuntime";
import { makeLiveLessonLlmAdapter } from "../../tutor/lessonStepLLM";
import { RoleplayRuntime } from "../../tutor/roleplayRuntime";
import { generateTurn } from "../../tutor/roleplayTurnLLM";
import { generateReport } from "../../tutor/roleplayReportLLM";
import { RemediationRuntime } from "../../tutor/remediationRuntime";
import { saveLessonState, clearLessonState } from "../../tutor/lessonState";
import { deriveScenarios } from "../../tutor/roleplaySceneLLM";
import {
  computeLessonSummary,
  shouldOfferRemediation,
  canShowRemediationOfferToday,
  markRemediationOfferShown,
  type RemediationOffer,
} from "../../tutor/lessonSummary";
import { getVendorKey, getVendorLabel } from "../../llm/llmIdentity";
import type { ErrorPattern } from "../../tutor/errorPatterns";
import type { ForensicReport, LessonState } from "../../tutor/types";

/** Build the player adapter that uses playerState + analysis to seek by cue index. */
function makePlayerAdapter() {
  return {
    seek: (cueIdx: number) => {
      const subs = useAnalysis.getState().subtitles;
      const t = subs[cueIdx]?.time;
      if (typeof t === "number") {
        usePlayerState.getState().seekHandler?.(t);
      }
    },
  };
}

/** Build a LessonRuntime from a LessonState (resume) or a fresh plan. */
function buildLessonRuntime(deps: {
  plan: import("../../tutor/types").LessonPlan;
  settings: import("../../types/settings").Settings;
  resumeFrom?: LessonState;
}): LessonRuntime {
  return new LessonRuntime({
    plan: deps.plan,
    llm: makeLiveLessonLlmAdapter(deps.settings),
    profile: { logEvent: (e) => useLearnerProfile.getState().logEvent(e) },
    persist: { save: saveLessonState, clear: clearLessonState },
    player: makePlayerAdapter(),
    resumeFrom: deps.resumeFrom,
  });
}

/** Single overlay portal dispatched from `useTutorRuntime.mode`. Mounts
 *  once in App.tsx so any tool or button can launch the right view via
 *  setMode. Lifecycle objects (runtimes) live in refs here — modes are
 *  pure data identifiers, runtimes are imperative. */
export function TutorPortalRoot() {
  const mode = useTutorRuntime((s) => s.mode);
  const setMode = useTutorRuntime((s) => s.setMode);
  const close = useTutorRuntime((s) => s.close);
  const settings = useSettings((s) => s.settings);

  const lessonRuntimeRef = useRef<LessonRuntime | null>(null);
  const rpRuntimeRef = useRef<RoleplayRuntime | null>(null);
  const remRuntimeRef = useRef<RemediationRuntime | null>(null);
  const [, forceRender] = useState(0);
  const tick = () => forceRender((v) => v + 1);
  const [rpReport, setRpReport] = useState<ForensicReport | null>(null);

  // Reset all imperative runtime refs when the overlay closes (mode → "none").
  // Without this, a stale lessonRuntimeRef survives and the resume guard
  // (`if (!lessonRuntimeRef.current)`) in lesson-in-progress reuses it for a
  // different video — showing the wrong lesson.
  const prevModeKindRef = useRef(mode.kind);
  useEffect(() => {
    if (prevModeKindRef.current !== "none" && mode.kind === "none") {
      lessonRuntimeRef.current = null;
      rpRuntimeRef.current = null;
      remRuntimeRef.current = null;
      setRpReport(null);
    }
    prevModeKindRef.current = mode.kind;
  }, [mode.kind]);

  // ──────────── Lesson — pre-class ────────────
  if (mode.kind === "lesson-preclass") {
    const videoTitle =
      usePlayerState.getState().videoTitle ?? mode.videoId;
    return (
      <LessonOverlay open onClose={close}>
        <LessonPreClass
          plan={mode.plan}
          videoTitle={videoTitle}
          videoDuration={0}
          vendorId={getVendorKey(settings)}
          vendorLabel={getVendorLabel(settings)}
          onCancel={close}
          onStart={async () => {
            const runtime = buildLessonRuntime({
              plan: mode.plan,
              settings,
            });
            lessonRuntimeRef.current = runtime;
            await runtime.start();
            setMode({ kind: "lesson-in-progress", videoId: mode.videoId });
          }}
        />
      </LessonOverlay>
    );
  }

  // ──────────── Lesson — in-progress ────────────
  if (mode.kind === "lesson-in-progress") {
    // Build or resume runtime when needed (handles both fresh start from
    // pre-class and resume from Player banner's setMode call).
    if (!lessonRuntimeRef.current) {
      if (mode.resumeFrom) {
        const runtime = buildLessonRuntime({
          plan: mode.resumeFrom.plan,
          settings,
          resumeFrom: mode.resumeFrom,
        });
        lessonRuntimeRef.current = runtime;
        // start() is async — fire and tick after it resolves
        void runtime.start().then(() => tick());
      } else {
        // No runtime and no resumeFrom — can't render; close gracefully.
        close();
        return null;
      }
    }

    const r = lessonRuntimeRef.current;
    return (
      <LessonOverlay open onClose={close}>
        <LessonStepView
          runtime={r}
          onStopVideo={() => usePlayerState.getState().pauseHandler?.()}
          onReplayCue={() => {
            // Replay just this anchor's cue audio (the original English) —
            // seek + play + auto-pause at the cue end. Cancel the TTS first
            // so the tutor's voice doesn't talk over the replayed sentence.
            const anchor = r.state.plan.anchors[r.state.currentAnchorIdx];
            if (!anchor) return;
            const cue = useAnalysis.getState().subtitles[anchor.cueIdx];
            if (!cue) return;
            ttsCancel();
            usePlayerState.getState().playRangeHandler?.(cue.time, cue.endTime);
          }}
          onRetry={() => {
            // Transient retry: jump the UI back to the question step. We
            // intentionally don't persist this — retry is an in-anchor
            // transient; on a mid-retry app kill, resuming at the feedback
            // step is fine (user can re-continue).
            r.state.currentStep = 3;
            tick();
          }}
          onSubmitAnswer={async (ans) => {
            await r.submitAnswer(ans);
            tick();
          }}
          onContinue={async () => {
            switch (r.state.currentStep) {
              case 1:
                await r.advanceToExplain();
                break;
              case 2:
                await r.advanceToQuestion();
                break;
              case 5: {
                if (r.hasNextAnchor()) {
                  await r.continueToNextAnchor();
                } else {
                  await r.finish();
                  setMode({
                    kind: "lesson-end",
                    videoId: mode.videoId,
                    state: r.state,
                  });
                  lessonRuntimeRef.current = null;
                  return;
                }
                break;
              }
            }
            tick();
          }}
        />
      </LessonOverlay>
    );
  }

  // ──────────── Lesson — end ────────────
  if (mode.kind === "lesson-end") {
    const summary = computeLessonSummary(mode.state);
    return (
      <LessonOverlay open onClose={close}>
        <LessonEndWithRemediationCheck
          summary={summary}
          videoId={mode.videoId}
          onClose={close}
          onStartRemediation={(pattern, errorIds) => {
            setMode({ kind: "remediation", pattern, candidateErrorIds: errorIds });
          }}
          onStartRoleplay={async () => {
            setMode({
              kind: "roleplay-picker",
              scenarios: [],
              sourceVideoId: mode.videoId,
              loading: true,
            });
          }}
        />
      </LessonOverlay>
    );
  }

  // ──────────── Roleplay — picker ────────────
  if (mode.kind === "roleplay-picker") {
    return (
      <LessonOverlay open onClose={close}>
        <RoleplayPickerHost
          loading={mode.loading}
          scenarios={mode.scenarios}
          sourceVideoId={mode.sourceVideoId}
          settings={settings}
          onCancel={close}
          onPick={(s) => {
            rpRuntimeRef.current = new RoleplayRuntime({
              scenario: s,
              llm: {
                generateTurn: (args) => generateTurn({ settings, ...args }),
              },
              profile: {
                logEvent: (e) => useLearnerProfile.getState().logEvent(e),
              },
            });
            setMode({ kind: "roleplay-in-progress", scenario: s });
          }}
        />
      </LessonOverlay>
    );
  }

  // ──────────── Roleplay — in-progress ────────────
  if (mode.kind === "roleplay-in-progress" && rpRuntimeRef.current) {
    const r = rpRuntimeRef.current;
    return (
      <RoleplayOverlay
        runtime={r}
        onClose={close}
        onFinishAndReport={async () => {
          await r.finish();
          const report = await generateReport({
            settings,
            scenario: r.state.scenario,
            turns: r.state.turns,
            observations: r.state.observedErrors,
          });
          // If the user closed the overlay (mode → "none") while generateReport
          // was in flight, bail out — don't spuriously reopen the overlay by
          // calling setMode on the global zustand store.
          if (useTutorRuntime.getState().mode.kind !== "roleplay-in-progress") return;
          setRpReport(report);
          setMode({
            kind: "roleplay-report",
            scenario: r.state.scenario,
            turns: r.state.turns,
            observations: r.state.observedErrors,
          });
        }}
      />
    );
  }

  // ──────────── Roleplay — report ────────────
  if (mode.kind === "roleplay-report" && rpReport) {
    return (
      <LessonOverlay open onClose={close}>
        <RoleplayReport
          report={rpReport}
          onClose={close}
          onRemediate={() => {
            const top = rpReport.patternHits[0];
            if (!top) return close();
            setMode({
              kind: "remediation",
              pattern: top.pattern,
              candidateErrorIds: [],
            });
          }}
          onAnother={() => {
            rpRuntimeRef.current = null;
            setRpReport(null);
            setMode({
              kind: "roleplay-picker",
              scenarios: [],
              sourceVideoId: mode.scenario.sourceVideoId,
              loading: true,
            });
          }}
        />
      </LessonOverlay>
    );
  }

  // ──────────── Remediation ────────────
  if (mode.kind === "remediation") {
    if (!remRuntimeRef.current) {
      remRuntimeRef.current = new RemediationRuntime({
        pattern: mode.pattern,
        candidateErrorIds: mode.candidateErrorIds,
        profile: {
          logEvent: (e) => useLearnerProfile.getState().logEvent(e),
          resolveEvents: (ids) => useLearnerProfile.getState().resolveEvents(ids),
        },
      });
      void remRuntimeRef.current.start();
    }
    return (
      <RemediationOverlay
        runtime={remRuntimeRef.current}
        onClose={() => {
          remRuntimeRef.current = null;
          close();
        }}
        onFinish={() => {
          remRuntimeRef.current = null;
          close();
        }}
      />
    );
  }

  return null;
}

/** Subcomponent — drives the two-phase scenario derivation so that ALL
 *  roleplay-picker entry points share it (lesson-end button, report
 *  "再来一个" button, and agent tool). The agent-tool path already derives
 *  inline and sets loading:false before the portal renders — so this host
 *  mounts with loading:false and the effect returns early (no double-
 *  derivation). The in-app buttons set loading:true, so the effect fires
 *  once, derives, then repopulates the mode. */
function RoleplayPickerHost(props: {
  loading: boolean;
  scenarios: import("../../tutor/types").RoleplayScenario[];
  sourceVideoId: string | null;
  settings: import("../../types/settings").Settings;
  onPick: (s: import("../../tutor/types").RoleplayScenario) => void;
  onCancel: () => void;
}) {
  const { loading, scenarios, sourceVideoId, settings, onPick, onCancel } = props;

  useEffect(() => {
    if (!loading) return;
    let cancelled = false;
    (async () => {
      const profile = await loadLearnerProfile();
      const derived = await deriveScenarios({
        settings,
        analysis: useAnalysis.getState().subtitles,
        profile,
        sourceVideoId,
      });
      if (cancelled) return;
      // bail if the user closed/navigated away from the picker mid-derivation
      if (useTutorRuntime.getState().mode.kind !== "roleplay-picker") return;
      useTutorRuntime.getState().setMode({
        kind: "roleplay-picker",
        scenarios: derived,
        sourceVideoId,
        loading: false,
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <RoleplayScenarioPicker
      scenarios={scenarios}
      loading={loading}
      onPick={onPick}
      onCancel={onCancel}
    />
  );
}

/** Subcomponent — runs the cooldown / throttle checks before rendering
 *  the actual LessonEnd. Lives here (not in LessonEnd itself) because
 *  the throttle is portal-level: re-checking on every render is fine,
 *  re-marking-shown should happen exactly once per mount. */
function LessonEndWithRemediationCheck(props: {
  summary: ReturnType<typeof computeLessonSummary>;
  videoId: string;
  onClose: () => void;
  onStartRemediation: (pattern: ErrorPattern, errorIds: string[]) => void;
  onStartRoleplay: () => void;
}) {
  const [offer, setOffer] = useState<RemediationOffer | null>(null);

  useEffect(() => {
    (async () => {
      const now = Date.now();
      if (!canShowRemediationOfferToday(now)) {
        setOffer(null);
        return;
      }
      const profile = await loadLearnerProfile();
      const o = shouldOfferRemediation(profile, now);
      if (o) {
        markRemediationOfferShown(now);
        setOffer(o);
      } else {
        setOffer(null);
      }
    })();
  }, []);

  return (
    <LessonEnd
      summary={props.summary}
      remediationOffer={offer}
      onClose={props.onClose}
      onStartRemediation={() =>
        offer && props.onStartRemediation(offer.pattern, props.summary.errorIds)
      }
      onStartRoleplay={props.onStartRoleplay}
    />
  );
}
