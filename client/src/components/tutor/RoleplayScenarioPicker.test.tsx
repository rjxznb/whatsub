import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RoleplayScenarioPicker } from "./RoleplayScenarioPicker";
import type { RoleplayScenario } from "../../tutor/types";

const scenarios: RoleplayScenario[] = [
  { id: "1", title: "你当旅客我当海关", setup: "入境", userRole: "旅客", agentRole: "海关", difficulty: 2, sourceVideoId: "v1", vocabHints: ["customs"] },
  { id: "2", title: "你当顾客我当店员", setup: "餐厅", userRole: "顾客", agentRole: "店员", difficulty: 1, sourceVideoId: null, vocabHints: ["order"] },
];

describe("RoleplayScenarioPicker", () => {
  it("renders all scenarios + difficulty stars", () => {
    render(
      <RoleplayScenarioPicker
        scenarios={scenarios}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("你当旅客我当海关")).toBeTruthy();
    expect(screen.getByText("你当顾客我当店员")).toBeTruthy();
    // difficulty 2 = ★★, difficulty 1 = ★
    expect(screen.getByText("★★")).toBeTruthy();
    expect(screen.getByText("★")).toBeTruthy();
  });

  it("clicking a scenario calls onPick with that scenario", () => {
    const onPick = vi.fn();
    render(
      <RoleplayScenarioPicker
        scenarios={scenarios}
        onPick={onPick}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("你当旅客我当海关").closest("button")!);
    expect(onPick).toHaveBeenCalledWith(scenarios[0]);
  });

  it("renders a loading state when scenarios is empty + loading=true", () => {
    render(
      <RoleplayScenarioPicker
        scenarios={[]}
        loading
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/正在生成场景/)).toBeTruthy();
  });
});
