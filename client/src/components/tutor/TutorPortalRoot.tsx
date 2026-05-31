import { useEffect, useRef, useState } from "react";
import { useTutorRuntime } from "../../store/tutorRuntime";
import { useSettings } from "../../store/settings";
import { useAnalysis } from "../../store/analysis";
import { usePlayerState } from "../../store/playerState";
import { useLearnerProfile, loadLearnerProfile } from "../../tutor/learnerProfile";
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
          onReplayCue={() => {
            // Seek back to the current anchor's cue
            const anchor = r.state.plan.anchors[r.state.currentAnchorIdx];
            if (anchor) makePlayerAdapter().seek(anchor.cueIdx);
          }}
          onRetry={() => {
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
        <RoleplayScenarioPicker
          scenarios={mode.scenarios}
          loading={mode.loading}
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
