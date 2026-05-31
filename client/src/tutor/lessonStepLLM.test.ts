import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseExplainFromStream,
  parseQuestionFromStream,
  parseFeedbackFromStream,
} from "./lessonStepLLM";

function fixture(name: string): string {
  return readFileSync(join(__dirname, "__fixtures__", name), "utf8");
}

describe("parseExplainFromStream", () => {
  it("returns plain text from the stream", async () => {
    const text = await parseExplainFromStream(fixture("lesson_step_explain.txt"));
    expect(text.length).toBeGreaterThan(20);
  });
});

describe("parseQuestionFromStream", () => {
  it("returns structured question", async () => {
    const q = await parseQuestionFromStream(fixture("lesson_step_question.txt"));
    expect(q).not.toBeNull();
    expect(q!.question.length).toBeGreaterThan(0);
    expect(q!.expectedAnswer.length).toBeGreaterThan(0);
  });
});

describe("parseFeedbackFromStream", () => {
  it("correct verdict + zero errors", async () => {
    const f = await parseFeedbackFromStream(fixture("lesson_step_feedback_correct.txt"));
    expect(f).not.toBeNull();
    expect(f!.verdict).toBe("correct");
    expect(f!.errors).toHaveLength(0);
  });

  it("incorrect verdict + ≥1 error event payload", async () => {
    const f = await parseFeedbackFromStream(fixture("lesson_step_feedback_incorrect.txt"));
    expect(f).not.toBeNull();
    expect(f!.verdict).toBe("incorrect");
    expect(f!.errors.length).toBeGreaterThanOrEqual(1);
    expect(typeof f!.errors[0].pattern).toBe("string");
    expect(typeof f!.errors[0].correction).toBe("string");
  });
});
