import type { ErrorPattern } from "./errorPatterns";
import {
  getQuestionsForPattern,
  type RemediationQuestion,
} from "./remediationQuestions";

const PASS_THRESHOLD = 0.7; // ≥70% to count as "passed" + resolve events

export function isAnswerCorrect(user: string, expected: string): boolean {
  const norm = (s: string) =>
    s.trim().toLowerCase().replace(/[.!?,;]+$/, "").replace(/\s+/g, " ");
  return norm(user) === norm(expected);
}

interface ProfileAdapter {
  resolveEvents(ids: string[]): Promise<void>;
  logEvent(event: import("./types").ErrorEvent): Promise<void>;
}

export interface RemediationRuntimeDeps {
  pattern: ErrorPattern;
  /** Error event ids from the originating context (e.g. lesson) that
   *  this session is trying to resolve. Bulk-marked resolved on pass. */
  candidateErrorIds: string[];
  profile: ProfileAdapter;
  questionCount?: number; // default 5
}

interface RuntimeState {
  pattern: ErrorPattern;
  questions: RemediationQuestion[];
  currentIdx: number;
  correctCount: number;
  finished: boolean;
}

export class RemediationRuntime {
  state: RuntimeState;

  constructor(private deps: RemediationRuntimeDeps) {
    this.state = {
      pattern: deps.pattern,
      questions: [],
      currentIdx: 0,
      correctCount: 0,
      finished: false,
    };
  }

  start(): void {
    const n = this.deps.questionCount ?? 5;
    this.state.questions = getQuestionsForPattern(this.deps.pattern, n);
  }

  submitAnswer(answer: string): void {
    const q = this.state.questions[this.state.currentIdx];
    if (!q) return;
    if (isAnswerCorrect(answer, q.expected)) this.state.correctCount += 1;
    this.state.currentIdx += 1;
  }

  isComplete(): boolean {
    return this.state.currentIdx >= this.state.questions.length;
  }

  async finish(): Promise<void> {
    this.state.finished = true;
    const pct = this.state.questions.length > 0
      ? this.state.correctCount / this.state.questions.length
      : 0;
    if (pct >= PASS_THRESHOLD && this.deps.candidateErrorIds.length > 0) {
      await this.deps.profile.resolveEvents(this.deps.candidateErrorIds);
    }
  }

  passPercent(): number {
    if (this.state.questions.length === 0) return 0;
    return this.state.correctCount / this.state.questions.length;
  }
}
