import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LessonPreClass } from "./LessonPreClass";
import type { LessonPlan } from "../../tutor/types";

const plan: LessonPlan = {
  videoId: "abc",
  estimateTokens: 3200,
  overview: "教入境对话最常见的 3 个表达",
  anchors: [
    { cueIdx: 3, topic: "I'm here for X", whyThisOne: "y", targetPatterns: ["preposition_wrong"] },
    { cueIdx: 12, topic: "现在完成时", whyThisOne: "y", targetPatterns: ["present_perfect_vs_past"] },
    { cueIdx: 24, topic: "customs declaration", whyThisOne: "y", targetPatterns: ["word_choice_unnatural"] },
  ],
};

describe("LessonPreClass", () => {
  it("renders overview + anchor topics + token badge", () => {
    render(
      <LessonPreClass
        plan={plan}
        videoTitle="Immigration Vlog"
        videoDuration={222}
        vendorId="deepseek"
        vendorLabel="DeepSeek"
        onStart={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/教入境对话/)).toBeTruthy();
    expect(screen.getByText(/I'm here for X/)).toBeTruthy();
    expect(screen.getByText(/customs declaration/)).toBeTruthy();
    expect(screen.getByText(/3,200/)).toBeTruthy();
    expect(screen.getByText(/Immigration Vlog/)).toBeTruthy();
  });

  it("clicking 开始上课 calls onStart", () => {
    const onStart = vi.fn();
    render(
      <LessonPreClass
        plan={plan}
        videoTitle="x"
        videoDuration={222}
        vendorId="deepseek"
        vendorLabel="DeepSeek"
        onStart={onStart}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /开始上课/ }));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("clicking 取消 calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <LessonPreClass
        plan={plan}
        videoTitle="x"
        videoDuration={222}
        vendorId="deepseek"
        vendorLabel="DeepSeek"
        onStart={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
