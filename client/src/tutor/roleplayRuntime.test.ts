import { describe, it, expect, vi, beforeEach } from "vitest";
import { RoleplayRuntime } from "./roleplayRuntime";
import type { RoleplayScenario } from "./types";

const scenario: RoleplayScenario = {
  id: "1",
  title: "你当旅客我当海关",
  setup: "入境",
  userRole: "旅客",
  agentRole: "海关",
  difficulty: 2,
  sourceVideoId: "v1",
  vocabHints: [],
};

const mockLlm = { generateTurn: vi.fn() };
const mockProfile = { logEvent: vi.fn() };

beforeEach(() => {
  mockLlm.generateTurn.mockReset();
  mockProfile.logEvent.mockReset();
});

describe("RoleplayRuntime", () => {
  it("starts empty + accepts first user turn", async () => {
    mockLlm.generateTurn.mockResolvedValue({ visibleText: "Welcome.", observedErrors: [] });
    const r = new RoleplayRuntime({ scenario, llm: mockLlm, profile: mockProfile });
    await r.submitUserMessage("Hi.");
    expect(r.state.turns).toHaveLength(2);
    expect(r.state.turns[0]).toMatchObject({ role: "user", text: "Hi." });
    expect(r.state.turns[1]).toMatchObject({ role: "agent", text: "Welcome." });
    expect(r.state.observedErrors).toEqual([]);
  });

  it("buffers observed errors silently (does NOT log to profile mid-conversation)", async () => {
    mockLlm.generateTurn.mockResolvedValue({
      visibleText: "I see.",
      observedErrors: [{ pattern: "chinglish_directness", userText: "I very like", correction: "I really like", detail: "x" }],
    });
    const r = new RoleplayRuntime({ scenario, llm: mockLlm, profile: mockProfile });
    await r.submitUserMessage("I very like the food.");
    expect(r.state.observedErrors).toHaveLength(1);
    expect(mockProfile.logEvent).not.toHaveBeenCalled();
  });

  it("finish() writes all buffered errors to profile + flips done flag", async () => {
    mockLlm.generateTurn.mockResolvedValue({
      visibleText: "I see.",
      observedErrors: [{ pattern: "chinglish_directness", userText: "I very like", correction: "I really like", detail: "x" }],
    });
    const r = new RoleplayRuntime({ scenario, llm: mockLlm, profile: mockProfile });
    await r.submitUserMessage("I very like the food.");
    await r.submitUserMessage("And the people.");
    await r.finish();
    expect(mockProfile.logEvent).toHaveBeenCalledTimes(2);
    expect(r.state.done).toBe(true);
  });

  it("turnLimit prevents submission past 20 user turns", async () => {
    mockLlm.generateTurn.mockResolvedValue({ visibleText: "ok", observedErrors: [] });
    const r = new RoleplayRuntime({ scenario, llm: mockLlm, profile: mockProfile, turnLimit: 3 });
    await r.submitUserMessage("1");
    await r.submitUserMessage("2");
    await r.submitUserMessage("3");
    await r.submitUserMessage("4"); // should be rejected
    expect(r.state.turns.filter((t) => t.role === "user")).toHaveLength(3);
  });
});
