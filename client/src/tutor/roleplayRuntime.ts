import type { RoleplayScenario, RoleplayTurn, ObservedError, ErrorEvent } from "./types";
import type { ParsedTurn } from "./roleplayTurnLLM";

// ─────────────────────────────────────────────────────────────────────────
// Adapter interfaces — allow injection of mocks in tests
// ─────────────────────────────────────────────────────────────────────────

interface LlmAdapter {
  generateTurn(args: {
    scenario: RoleplayScenario;
    history: RoleplayTurn[];
    userMessage: string;
  }): Promise<ParsedTurn>;
}

interface ProfileAdapter {
  logEvent(event: ErrorEvent): Promise<void>;
}

interface Deps {
  scenario: RoleplayScenario;
  llm: LlmAdapter;
  profile: ProfileAdapter;
  /** Default 20. */
  turnLimit?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// State shape
// ─────────────────────────────────────────────────────────────────────────

export interface RuntimeState {
  scenario: RoleplayScenario;
  turns: RoleplayTurn[];
  /** Buffered until finish() — NOT written to profile mid-conversation. */
  observedErrors: ObservedError[];
  loading: boolean;
  done: boolean;
  startedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────
// RoleplayRuntime
// ─────────────────────────────────────────────────────────────────────────

export class RoleplayRuntime {
  state: RuntimeState;

  constructor(private deps: Deps) {
    this.state = {
      scenario: deps.scenario,
      turns: [],
      observedErrors: [],
      loading: false,
      done: false,
      startedAt: Date.now(),
    };
  }

  userTurnCount(): number {
    return this.state.turns.filter((t) => t.role === "user").length;
  }

  async submitUserMessage(text: string): Promise<void> {
    const limit = this.deps.turnLimit ?? 20;
    if (this.userTurnCount() >= limit) return;

    const userTurn: RoleplayTurn = { role: "user", text, ts: Date.now() };
    this.state.turns.push(userTurn);
    this.state.loading = true;

    // Pass history EXCLUDING the just-pushed user turn; the runtime hands
    // the new user message separately so generateTurn can fold it into
    // the userPrompt string (Correction 2 upstream).
    const historyBeforeThisTurn = this.state.turns.slice(0, -1);

    const result = await this.deps.llm.generateTurn({
      scenario: this.deps.scenario,
      history: historyBeforeThisTurn,
      userMessage: text,
    });

    const agentTurn: RoleplayTurn = {
      role: "agent",
      text: result.visibleText,
      ts: Date.now(),
    };
    this.state.turns.push(agentTurn);

    // Buffer silently — do NOT write to profile yet.
    this.state.observedErrors.push(...result.observedErrors);
    this.state.loading = false;
  }

  /** Write all buffered errors to the learner profile, then mark done. */
  async finish(): Promise<void> {
    for (const err of this.state.observedErrors) {
      const event: ErrorEvent = {
        id: newId(),
        ts: Date.now(),
        source: {
          type: "roleplay",
          videoId: this.deps.scenario.sourceVideoId,
          cueIdx: null,
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
    }
    this.state.done = true;
  }
}
