import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LessonEnd } from "./LessonEnd";

const baseSummary = {
  totalAnchors: 3,
  correctCount: 2,
  topicsLearned: ["T1", "T2", "T3"],
  errorCount: 2,
  errorIds: ["e1", "e2"],
};

describe("LessonEnd", () => {
  it("renders summary stats + topic list", () => {
    render(
      <LessonEnd
        summary={baseSummary}
        remediationOffer={null}
        onStartRemediation={vi.fn()}
        onStartRoleplay={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 \/ 3/)).toBeTruthy();
    expect(screen.getByText("T1")).toBeTruthy();
    expect(screen.getByText(/2 条错误已写入/)).toBeTruthy();
  });

  it("does NOT render remediation banner when offer is null", () => {
    render(
      <LessonEnd
        summary={baseSummary}
        remediationOffer={null}
        onStartRemediation={vi.fn()}
        onStartRoleplay={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/3 分钟专项/)).toBeNull();
  });

  it("renders remediation banner with pattern label + count when offered", () => {
    render(
      <LessonEnd
        summary={baseSummary}
        remediationOffer={{ pattern: "past_tense_irregular", occurrences: 4 }}
        onStartRemediation={vi.fn()}
        onStartRoleplay={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/本周第 4 次/)).toBeTruthy();
    expect(screen.getByText(/过去式不规则/)).toBeTruthy();
  });

  it("clicking 来 3 分钟专项 invokes onStartRemediation", () => {
    const onStartRemediation = vi.fn();
    render(
      <LessonEnd
        summary={baseSummary}
        remediationOffer={{ pattern: "past_tense_irregular", occurrences: 4 }}
        onStartRemediation={onStartRemediation}
        onStartRoleplay={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /3 分钟专项/ }));
    expect(onStartRemediation).toHaveBeenCalledOnce();
  });
});
