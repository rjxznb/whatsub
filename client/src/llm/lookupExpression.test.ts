import { describe, it, expect, vi } from "vitest";
import { lookupExpression, extractJsonObject } from "./lookupExpression";
import type { Provider } from "./providers/types";

function mockProvider(chunks: string[]): Provider {
  return {
    async *stream() {
      for (const c of chunks) yield c;
    },
  };
}

describe("extractJsonObject", () => {
  it("returns the input when it's already plain JSON", () => {
    expect(extractJsonObject(`{"a":1}`)).toBe(`{"a":1}`);
  });

  it("strips ```json fences", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe(`{"a":1}`);
  });

  it("strips bare ``` fences", () => {
    expect(extractJsonObject("```\n{\"a\":1}\n```")).toBe(`{"a":1}`);
  });

  it("strips leading prose", () => {
    expect(extractJsonObject(`好的，结果是：{"a":1}`)).toBe(`{"a":1}`);
  });

  it("handles trailing prose", () => {
    expect(extractJsonObject(`{"a":1}\n以上是结果`)).toBe(`{"a":1}`);
  });

  it("picks first { to last } when nested", () => {
    expect(extractJsonObject(`junk{"a":{"b":1}}tail`)).toBe(`{"a":{"b":1}}`);
  });
});

describe("lookupExpression", () => {
  it("parses JSON from streamed chunks", async () => {
    const provider = mockProvider([
      `{"meaningZh":"显然`,
      `","usage":"口语里表达..."}`,
    ]);
    const result = await lookupExpression("apparently", "She apparently left.", provider);
    expect(result).toEqual({ meaningZh: "显然", usage: "口语里表达..." });
  });

  it("strips markdown code fence", async () => {
    const provider = mockProvider([
      "```json\n",
      `{"meaningZh":"显然","usage":"x"}`,
      "\n```",
    ]);
    const result = await lookupExpression("apparently", "ctx", provider);
    expect(result).toEqual({ meaningZh: "显然", usage: "x" });
  });

  it("trims whitespace in fields", async () => {
    const provider = mockProvider([`{"meaningZh":"  显然  ","usage":" "}`]);
    const result = await lookupExpression("apparently", "ctx", provider);
    expect(result).toEqual({ meaningZh: "显然", usage: "" });
  });

  it("coerces missing fields to empty string", async () => {
    const provider = mockProvider([`{"meaningZh":"显然"}`]);
    const result = await lookupExpression("apparently", "ctx", provider);
    expect(result).toEqual({ meaningZh: "显然", usage: "" });
  });

  it("propagates AbortError", async () => {
    const provider: Provider = {
      async *stream() {
        const err = new DOMException("aborted", "AbortError");
        throw err;
      },
    };
    await expect(lookupExpression("x", "y", provider)).rejects.toThrow(/aborted/i);
  });

  it("throws on unparseable response", async () => {
    const provider = mockProvider(["not json at all"]);
    await expect(lookupExpression("x", "y", provider)).rejects.toThrow();
  });

  it("passes signal through to provider", async () => {
    const stream = vi.fn(async function* () {
      yield `{"meaningZh":"x","usage":"y"}`;
    });
    const provider: Provider = { stream };
    const ctrl = new AbortController();
    await lookupExpression("a", "b", provider, ctrl.signal);
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ signal: ctrl.signal })
    );
  });
});
