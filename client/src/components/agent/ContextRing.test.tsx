import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextRing } from "./ContextRing";
import { estimateMessagesTokens } from "../../agent/history";
import type { Message } from "../../types/agent";

describe("estimateMessagesTokens", () => {
  it("sums per-message tokens (with overhead)", () => {
    const msgs: Message[] = [
      { role: "user", id: "u", ts: 0, content: "你好世界" }, // 4 + 4 overhead
    ];
    expect(estimateMessagesTokens(msgs)).toBe(8);
    expect(estimateMessagesTokens([])).toBe(0);
  });
});

describe("ContextRing", () => {
  it("renders a percentage gauge", () => {
    render(<ContextRing />);
    // Empty/near-empty conversation → a low percentage label is shown.
    expect(screen.getByText(/%$/)).toBeTruthy();
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/上下文占用/);
  });
});
