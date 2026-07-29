import { describe, it, expect } from "vitest";
import { JsonLineParser, type InvalidJsonLine } from "./streamingJson";

describe("JsonLineParser", () => {
  it("emits objects as complete lines arrive", () => {
    const parser = new JsonLineParser();
    const out: unknown[] = [];
    parser.feed('{"a": 1}\n{"b":', (obj) => out.push(obj));
    expect(out).toEqual([{ a: 1 }]);
    parser.feed(' 2}\n', (obj) => out.push(obj));
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("ignores blank lines", () => {
    const parser = new JsonLineParser();
    const out: unknown[] = [];
    parser.feed('\n{"a":1}\n\n{"b":2}\n', (obj) => out.push(obj));
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("flush emits any pending complete object on its own line", () => {
    const parser = new JsonLineParser();
    const out: unknown[] = [];
    parser.feed('{"x":42}', (obj) => out.push(obj));
    expect(out).toEqual([]);
    parser.flush((obj) => out.push(obj));
    expect(out).toEqual([{ x: 42 }]);
  });

  it("skips invalid JSON lines silently", () => {
    const parser = new JsonLineParser();
    const out: unknown[] = [];
    parser.feed('not json\n{"ok":true}\n', (obj) => out.push(obj));
    expect(out).toEqual([{ ok: true }]);
  });

  it("reports each non-empty invalid line when a handler is provided", () => {
    const parser = new JsonLineParser();
    const out: unknown[] = [];
    const invalid: InvalidJsonLine[] = [];

    parser.feed(
      ' not json \n\n{"ok":true}\n',
      (obj) => out.push(obj),
      (line) => invalid.push(line),
    );

    expect(out).toEqual([{ ok: true }]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].line).toBe("not json");
    expect(invalid[0].error).toBeInstanceOf(SyntaxError);
  });

  it("reports an invalid trailing line during flush", () => {
    const parser = new JsonLineParser();
    const invalid: InvalidJsonLine[] = [];

    parser.feed("trailing prose", () => {});
    parser.flush(() => {}, (line) => invalid.push(line));

    expect(invalid).toHaveLength(1);
    expect(invalid[0].line).toBe("trailing prose");
    expect(invalid[0].error).toBeInstanceOf(SyntaxError);
  });

  it("reports the parse cause without swallowing later valid lines", () => {
    const parser = new JsonLineParser();
    const invalid: InvalidJsonLine[] = [];
    const valid: unknown[] = [];

    parser.feed(
      '{"index":1,"translation":"broken\n{"index":2,"translation":"ok"}\n',
      (value) => valid.push(value),
      (failure) => invalid.push(failure),
    );

    expect(invalid).toHaveLength(1);
    expect(invalid[0].line).toContain('"index":1');
    expect(invalid[0].error).toBeInstanceOf(SyntaxError);
    expect(valid).toEqual([{ index: 2, translation: "ok" }]);
  });
});
