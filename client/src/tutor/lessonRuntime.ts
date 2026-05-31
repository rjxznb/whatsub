import type { LessonPlan, LessonState, ErrorEvent, AnchorRecord } from "./types";
import type { LessonQuestion, LessonFeedback } from "./lessonStepLLM";

// ──────────── Interfaces (injectable for testing) ────────────

export interface LessonLlmAdapter {
  explain(args: { plan: LessonPlan; anchorIdx: number; analysis: unknown }): Promise<string>;
  question(args: { plan: LessonPlan; anchorIdx: number; explainText: string }): Promise<LessonQuestion | null>;
  feedback(args: {
    plan: LessonPlan;
    anchorIdx: number;
    question: LessonQuestion;
    userAnswer: string;
    attempt: number;
  }): Promise<LessonFeedback | null>;
}

export interface ProfileAdapter {
  logEvent(event: ErrorEvent): Promise<void>;
}

export interface PersistAdapter {
  save(state: LessonState): Promise<void>;
  clear(): Promise<void>;
}

export interface PlayerAdapter {
  seek(cueIdx: number): void;
}

interface RuntimeState extends LessonState {
  currentExplainText: string;
  currentQuestion: LessonQuestion | null;
  currentFeedback: LessonFeedback | null;
  attemptsThisAnchor: number;
  canRetry: boolean;          // true after wrong attempt 1
  answerRevealed: boolean;    // true after wrong attempt 2
  completed: boolean;
}

function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const HINT_THRESHOLD = 1;     // wrong attempts before hint
const REVEAL_THRESHOLD = 2;   // wrong attempts before answer reveal

export class LessonRuntime {
  state: RuntimeState;

  constructor(
    private deps: {
      plan: LessonPlan;
      llm: LessonLlmAdapter;
      profile: ProfileAdapter;
      persist: PersistAdapter;
      player: PlayerAdapter;
      analysis?: unknown;
      resumeFrom?: LessonState;
    },
  ) {
    const base: LessonState = deps.resumeFrom ?? {
      videoId: deps.plan.videoId,
      startedAt: Date.now(),
      plan: deps.plan,
      currentAnchorIdx: 0,
      currentStep: 1,
      history: [],
      errorsThisSession: [],
    };
    this.state = {
      ...base,
      currentExplainText: "",
      currentQuestion: null,
      currentFeedback: null,
      attemptsThisAnchor: 0,
      canRetry: false,
      answerRevealed: false,
      completed: false,
    };
  }

  async start(): Promise<void> {
    const anchor = this.deps.plan.anchors[this.state.currentAnchorIdx];
    if (anchor) this.deps.player.seek(anchor.cueIdx);
    await this.persist();
  }

  async advanceToExplain(): Promise<void> {
    const explain = await this.deps.llm.explain({
      plan: this.deps.plan,
      anchorIdx: this.state.currentAnchorIdx,
      analysis: this.deps.analysis,
    });
    this.state.currentExplainText = explain;
    this.state.currentStep = 2;
    await this.persist();
  }

  async advanceToQuestion(): Promise<void> {
    const q = await this.deps.llm.question({
      plan: this.deps.plan,
      anchorIdx: this.state.currentAnchorIdx,
      explainText: this.state.currentExplainText,
    });
    this.state.currentQuestion = q;
    this.state.currentStep = 3;
    await this.persist();
  }

  async submitAnswer(answer: string): Promise<void> {
    if (!this.state.currentQuestion) return;
    this.state.attemptsThisAnchor += 1;
    const f = await this.deps.llm.feedback({
      plan: this.deps.plan,
      anchorIdx: this.state.currentAnchorIdx,
      question: this.state.currentQuestion,
      userAnswer: answer,
      attempt: this.state.attemptsThisAnchor,
    });
    this.state.currentFeedback = f;
    this.state.currentStep = 5;

    if (f && f.errors.length > 0) {
      const anchor = this.deps.plan.anchors[this.state.currentAnchorIdx];
      for (const err of f.errors) {
        const event: ErrorEvent = {
          id: newId(),
          ts: Date.now(),
          source: {
            type: "lesson",
            videoId: this.deps.plan.videoId,
            cueIdx: anchor?.cueIdx ?? null,
            questionId: null,
          },
          pattern: err.pattern,
          detail: err.detail,
          userInput: err.userText,
          correction: err.correction,
          resolved: false,
          resolvedAt: null,
        };
        await this.deps.profile.logEvent(event);
        this.state.errorsThisSession.push(event.id);
      }
    }

    // Decide hint / reveal / proceed
    if (f?.verdict === "correct" || f?.verdict === "partial") {
      this.state.canRetry = false;
      this.state.answerRevealed = false;
    } else {
      // incorrect
      if (this.state.attemptsThisAnchor >= REVEAL_THRESHOLD) {
        this.state.canRetry = false;
        this.state.answerRevealed = true;
      } else if (this.state.attemptsThisAnchor >= HINT_THRESHOLD) {
        this.state.canRetry = true;
        this.state.answerRevealed = false;
      }
    }
    await this.persist();
  }

  async continueToNextAnchor(): Promise<void> {
    // Snapshot this anchor's record
    const anchor = this.deps.plan.anchors[this.state.currentAnchorIdx];
    const record: AnchorRecord = {
      cueIdx: anchor?.cueIdx ?? 0,
      topic: anchor?.topic ?? "",
      attempts: this.state.attemptsThisAnchor,
      errorIds: [...this.state.errorsThisSession],
      finalCorrect: this.state.currentFeedback?.verdict === "correct"
        || this.state.currentFeedback?.verdict === "partial",
    };
    this.state.history.push(record);

    // Advance
    this.state.currentAnchorIdx += 1;
    this.state.currentStep = 1;
    this.state.currentExplainText = "";
    this.state.currentQuestion = null;
    this.state.currentFeedback = null;
    this.state.attemptsThisAnchor = 0;
    this.state.canRetry = false;
    this.state.answerRevealed = false;

    const next = this.deps.plan.anchors[this.state.currentAnchorIdx];
    if (next) this.deps.player.seek(next.cueIdx);
    await this.persist();
  }

  hasMoreAnchors(): boolean {
    return this.state.currentAnchorIdx < this.deps.plan.anchors.length;
  }

  async finish(): Promise<void> {
    this.state.completed = true;
    await this.deps.persist.clear();
  }

  private async persist(): Promise<void> {
    if (this.state.completed) return;
    const persistable: LessonState = {
      videoId: this.state.videoId,
      startedAt: this.state.startedAt,
      plan: this.state.plan,
      currentAnchorIdx: this.state.currentAnchorIdx,
      currentStep: this.state.currentStep,
      history: this.state.history,
      errorsThisSession: this.state.errorsThisSession,
    };
    await this.deps.persist.save(persistable);
  }
}
