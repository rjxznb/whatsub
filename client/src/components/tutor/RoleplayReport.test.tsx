import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoleplayReport } from "./RoleplayReport";
import type { ForensicReport } from "../../tutor/types";

const report: ForensicReport = {
  totalUserTurns: 14,
  naturalCount: 5,
  chinglishExamples: [{ original: "I very like", better: "I really like" }],
  patternHits: [{ pattern: "past_tense_irregular", count: 3, example: "I goed", monthCount: 9 }],
  registerNotes: ["Furthermore in casual speech is too formal"],
  fallback: false,
};

describe("RoleplayReport", () => {
  it("renders 14 轮 + 5 句很自然 + chinglish + pattern", () => {
    render(<RoleplayReport report={report} onAnother={vi.fn()} onRemediate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/14 轮/)).toBeTruthy();
    expect(screen.getByText(/5 句很自然/)).toBeTruthy();
    expect(screen.getByText(/I very like/)).toBeTruthy();
    expect(screen.getByText(/I really like/)).toBeTruthy();
    expect(screen.getByText(/过去式不规则/)).toBeTruthy();
    expect(screen.getByText(/本月第 9 次/)).toBeTruthy();
  });

  it("renders fallback warning when report.fallback is true", () => {
    render(<RoleplayReport report={{ ...report, fallback: true }} onAnother={vi.fn()} onRemediate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/使用更强模型/)).toBeTruthy();
  });
});
