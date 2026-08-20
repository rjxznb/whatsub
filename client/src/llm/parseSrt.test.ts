import { describe, it, expect } from "vitest";
import { parseSrt } from "./parseSrt";

describe("parseSrt", () => {
  it("parses single cue", () => {
    const cues = parseSrt("1\n00:00:01,000 --> 00:00:03,500\nHello world\n");
    expect(cues).toEqual([
      { index: 1, time: 1.0, endTime: 3.5, text: "Hello world" },
    ]);
  });

  it("parses multiple cues with multi-line text", () => {
    const cues = parseSrt(
      "1\n00:00:01,000 --> 00:00:03,500\nFirst\n\n2\n00:00:04,200 --> 00:00:06,800\nLine A\nLine B\n"
    );
    expect(cues).toHaveLength(2);
    expect(cues[1].text).toBe("Line A Line B");
  });

  it("supports hour timecodes", () => {
    const cues = parseSrt("1\n01:02:03,456 --> 01:02:05,000\nLater\n");
    expect(cues[0].time).toBeCloseTo(3723.456, 3);
  });

  it("handles CRLF line endings", () => {
    const cues = parseSrt("1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n");
    expect(cues[0].text).toBe("Hi");
  });

  it("merges adjacent identical Whisper repeats", () => {
    const cues = parseSrt(
      "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n" +
      "2\n00:00:02,000 --> 00:00:03,000\nHello\n",
    );
    expect(cues).toEqual([{ index: 1, time: 1, endTime: 3, text: "Hello" }]);
  });

  it("merges a long conjunction-prefixed hallucination streak", () => {
    const cues = parseSrt(
      "1\n00:00:01,000 --> 00:00:02,000\nI'm leaving\n\n" +
      "2\n00:00:02,000 --> 00:00:03,000\nand I'm leaving\n\n" +
      "3\n00:00:03,000 --> 00:00:04,000\nand I'm leaving\n",
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].endTime).toBe(4);
  });

  it("does not merge non-adjacent repeats", () => {
    const cues = parseSrt(
      "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n" +
      "2\n00:00:05,000 --> 00:00:06,000\nHello\n",
    );
    expect(cues).toHaveLength(2);
  });
});
