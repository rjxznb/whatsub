import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoleplayOverlay } from "./RoleplayOverlay";
import { RoleplayRuntime } from "../../tutor/roleplayRuntime";

const scenario = {
  id: "1",
  title: "你当旅客我当海关",
  setup: "入境",
  userRole: "旅客",
  agentRole: "海关",
  difficulty: 2 as 2,
  sourceVideoId: null,
  vocabHints: [],
};

const mockLlm = { generateTurn: vi.fn() };
const mockProfile = { logEvent: vi.fn() };

describe("RoleplayOverlay", () => {
  it("renders the role card + textarea + 0 / 20 counter at start", () => {
    const r = new RoleplayRuntime({ scenario, llm: mockLlm, profile: mockProfile });
    render(<RoleplayOverlay runtime={r} onFinishAndReport={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/旅客/)).toBeTruthy();
    expect(screen.getByText(/海关/)).toBeTruthy();
    expect(screen.getByText(/0 \/ 20/)).toBeTruthy();
  });

  it("clicking 结束并复盘 calls onFinishAndReport", async () => {
    const r = new RoleplayRuntime({ scenario, llm: mockLlm, profile: mockProfile });
    const onFinish = vi.fn();
    render(<RoleplayOverlay runtime={r} onFinishAndReport={onFinish} onClose={vi.fn()} />);
    screen.getByRole("button", { name: /结束并复盘/ }).click();
    expect(onFinish).toHaveBeenCalledOnce();
  });
});
