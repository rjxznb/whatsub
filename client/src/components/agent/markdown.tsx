// src/components/agent/markdown.tsx
//
// Hand-rolled inline markdown renderer for assistant text blocks. Zero deps.
// Why not pull in a real parser: we control the assistant output, the surface
// is tiny (paragraphs / bold / italic / inline code / fences / lists / h2-h3),
// and adding remark+react-remark pulls in ~80 KB plus a wave of supply-chain
// transitive deps for a feature that ships in a 600px-wide chat row.
//
// Supported:
//   - Paragraphs (blank-line separated)
//   - **bold** *italic* `inline code`
//   - ```fenced code blocks``` (no language highlighting)
//   - `- ` / `* ` unordered lists
//   - `1. ` ordered lists
//   - `## ` h2, `### ` h3 (h1 deliberately omitted — assistant rarely uses it
//     and an h1 at this size would compete with the chat header)
//
// Intentionally skipped for v1:
//   - Links / images / tables / blockquotes / strikethrough — assistant text is
//     mostly conversational; we add these the first time a real user-visible
//     prompt produces them.
//
// `withCursor` appends a blinking ▍ at the very end, used by AssistantBubble
// to indicate the final text block of a still-streaming message.

import type { ReactNode } from "react";

interface Props {
  text: string;
  /** Show blinking cursor at the end of the rendered output (streaming). */
  withCursor?: boolean;
}

export function MarkdownText({ text, withCursor }: Props) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => (
        <BlockView
          key={i}
          block={b}
          cursorOnLast={!!withCursor && i === blocks.length - 1}
        />
      ))}
    </div>
  );
}

// ── Block types ─────────────────────────────────────────────────────────────

type Block =
  | { kind: "para"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; text: string };

/**
 * Split raw text into a sequence of Blocks. Fenced code blocks short-circuit
 * the line-by-line classifier because their contents are opaque.
 */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      // Skip closing ``` if present
      if (i < lines.length) i++;
      blocks.push({ kind: "code", text: codeLines.join("\n") });
      continue;
    }

    // Headings
    if (line.startsWith("### ")) {
      blocks.push({ kind: "h3", text: line.slice(4) });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ kind: "h2", text: line.slice(3) });
      i++;
      continue;
    }

    // Unordered list — consume contiguous list lines
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Blank line — separator
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — consume contiguous non-empty, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("## ") &&
      !lines[i].startsWith("### ") &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "para", text: paraLines.join("\n") });
  }

  return blocks;
}

// ── Inline pass ─────────────────────────────────────────────────────────────

/**
 * Render a snippet of inline markdown. Recognises:
 *   `code`   → <code>
 *   **bold** → <strong>
 *   *italic* → <em> (NOT if it's the leading `*` of a list — that's already
 *              stripped by the block pass; here `*x*` is unambiguous)
 *
 * The parser is a single forward scan; nested ** inside * (or vice versa) is
 * not supported and is treated as literal text after the first delimiter
 * fails to find its mate. Good enough for assistant chat.
 */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };

  while (i < text.length) {
    // Inline code: backtick … backtick
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        out.push(
          <code
            key={out.length}
            className="bg-zinc-800 px-1 py-0.5 rounded text-[12px] text-amber-300 font-mono"
          >
            {text.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }

    // Bold: **…**
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        flush();
        out.push(
          <strong key={out.length} className="font-semibold text-zinc-100">
            {renderInline(text.slice(i + 2, end))}
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }

    // Italic: *…* — single asterisk, not part of **
    if (
      text[i] === "*" &&
      text[i + 1] !== "*" &&
      // and we're not the closing of a ** we missed
      !(i > 0 && text[i - 1] === "*")
    ) {
      const end = findItalicClose(text, i + 1);
      if (end !== -1) {
        flush();
        out.push(
          <em key={out.length} className="italic">
            {renderInline(text.slice(i + 1, end))}
          </em>,
        );
        i = end + 1;
        continue;
      }
    }

    buf += text[i];
    i++;
  }

  flush();
  return out;
}

function findItalicClose(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "*" && text[i + 1] !== "*" && text[i - 1] !== "*") {
      return i;
    }
  }
  return -1;
}

// ── Block view ──────────────────────────────────────────────────────────────

function CursorSpan() {
  return (
    <span
      aria-hidden
      className="inline-block w-1 h-4 ml-0.5 bg-zinc-400 animate-pulse align-middle"
    />
  );
}

function BlockView({
  block,
  cursorOnLast,
}: {
  block: Block;
  cursorOnLast: boolean;
}) {
  switch (block.kind) {
    case "para":
      return (
        <p className="whitespace-pre-wrap break-words">
          {renderInline(block.text)}
          {cursorOnLast && <CursorSpan />}
        </p>
      );
    case "h2":
      return (
        <h2 className="text-base font-semibold text-zinc-100 mt-3 mb-1">
          {renderInline(block.text)}
          {cursorOnLast && <CursorSpan />}
        </h2>
      );
    case "h3":
      return (
        <h3 className="text-sm font-semibold text-zinc-200 mt-2 mb-0.5">
          {renderInline(block.text)}
          {cursorOnLast && <CursorSpan />}
        </h3>
      );
    case "ul":
      return (
        <ul className="list-disc ml-5 space-y-0.5">
          {block.items.map((it, i) => (
            <li key={i}>
              {renderInline(it)}
              {cursorOnLast && i === block.items.length - 1 && <CursorSpan />}
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="list-decimal ml-5 space-y-0.5">
          {block.items.map((it, i) => (
            <li key={i}>
              {renderInline(it)}
              {cursorOnLast && i === block.items.length - 1 && <CursorSpan />}
            </li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre className="bg-zinc-950 rounded p-3 text-[12px] text-zinc-200 font-mono overflow-x-auto">
          <code>{block.text}</code>
          {cursorOnLast && <CursorSpan />}
        </pre>
      );
  }
}
