import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownText, parseBlocks } from "./markdown";

describe("parseBlocks", () => {
  it("splits paragraphs by blank line", () => {
    const blocks = parseBlocks("hello\n\nworld");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: "para", text: "hello" });
    expect(blocks[1]).toEqual({ kind: "para", text: "world" });
  });

  it("classifies a single line as paragraph", () => {
    const blocks = parseBlocks("just one line");
    expect(blocks).toEqual([{ kind: "para", text: "just one line" }]);
  });

  it("classifies ## as h2 and ### as h3", () => {
    const blocks = parseBlocks(`## Section\n\n### Sub`);
    expect(blocks).toEqual([
      { kind: "h2", text: "Section" },
      { kind: "h3", text: "Sub" },
    ]);
  });

  it("collects contiguous - lines into a single ul", () => {
    const blocks = parseBlocks(`- a\n- b\n- c`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "ul", items: ["a", "b", "c"] });
  });

  it("collects contiguous 1. lines into a single ol", () => {
    const blocks = parseBlocks(`1. one\n2. two`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "ol", items: ["one", "two"] });
  });

  it("treats ``` … ``` as a code block", () => {
    const blocks = parseBlocks("```\nlet x = 1;\nx + 2\n```");
    expect(blocks).toEqual([{ kind: "code", text: "let x = 1;\nx + 2" }]);
  });
});

describe("MarkdownText", () => {
  it("renders plain text inside a paragraph", () => {
    const { container } = render(<MarkdownText text="hello world" />);
    expect(container.textContent).toContain("hello world");
    expect(container.querySelector("p")).toBeTruthy();
  });

  it("renders **bold** as <strong>", () => {
    const { container } = render(<MarkdownText text="say **hi** here" />);
    const strong = container.querySelector("strong");
    expect(strong).toBeTruthy();
    expect(strong!.textContent).toBe("hi");
  });

  it("renders *italic* as <em>", () => {
    const { container } = render(<MarkdownText text="this is *nice*" />);
    const em = container.querySelector("em");
    expect(em).toBeTruthy();
    expect(em!.textContent).toBe("nice");
  });

  it("renders `inline code` as <code>", () => {
    const { container } = render(<MarkdownText text="use `npm install`" />);
    const code = container.querySelector("code");
    expect(code).toBeTruthy();
    expect(code!.textContent).toBe("npm install");
  });

  it("renders a fenced code block as <pre><code>", () => {
    const { container } = render(
      <MarkdownText text={"```\nconst x = 1;\n```"} />,
    );
    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre!.textContent).toContain("const x = 1;");
  });

  it("renders - list as <ul><li>", () => {
    const { container } = render(<MarkdownText text={"- one\n- two"} />);
    const ul = container.querySelector("ul");
    expect(ul).toBeTruthy();
    const items = ul!.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe("one");
    expect(items[1].textContent).toBe("two");
  });

  it("renders 1. list as <ol><li>", () => {
    const { container } = render(<MarkdownText text={"1. first\n2. second"} />);
    const ol = container.querySelector("ol");
    expect(ol).toBeTruthy();
    expect(ol!.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders paragraphs separated by blank lines", () => {
    const { container } = render(<MarkdownText text={"alpha\n\nbeta"} />);
    const paras = container.querySelectorAll("p");
    expect(paras).toHaveLength(2);
    expect(paras[0].textContent).toBe("alpha");
    expect(paras[1].textContent).toBe("beta");
  });

  it("withCursor=true appends a blinking span to the last block", () => {
    const { container } = render(
      <MarkdownText text="streaming" withCursor />,
    );
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).toBeTruthy();
  });

  it("withCursor=false omits the blinking span", () => {
    const { container } = render(<MarkdownText text="static" />);
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("renders ## as h2", () => {
    const { container } = render(<MarkdownText text="## Title" />);
    const h2 = container.querySelector("h2");
    expect(h2).toBeTruthy();
    expect(h2!.textContent).toBe("Title");
  });
});
