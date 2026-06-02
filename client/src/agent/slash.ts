// src/agent/slash.ts
//
// Pure helpers for user-defined slash commands (see store/slashCommands.ts).
// Parsing + $ARGUMENTS expansion + the input-autocomplete predicate/filter.

import type { SlashCommand } from "../store/slashCommands";

export interface ParsedSlash {
  name: string;
  args: string;
}

/** Parse "/name the rest" → { name, args }, or null if not a slash command. */
export function parseSlash(input: string): ParsedSlash | null {
  const m = /^\/([^\s/]+)\s*([\s\S]*)$/.exec(input.trimStart());
  if (!m) return null;
  return { name: m[1], args: m[2].trim() };
}

/** Substitute `$ARGUMENTS` in the template (or append args if no placeholder),
 *  then collapse the runs of spaces that an empty substitution can leave. */
export function applyArgs(template: string, args: string): string {
  const out = template.includes("$ARGUMENTS")
    ? template.split("$ARGUMENTS").join(args)
    : args
      ? `${template} ${args}`
      : template;
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/** Expand `input` against the command list; null if it isn't a defined command
 *  (caller then sends the raw text unchanged). */
export function expandSlash(input: string, commands: SlashCommand[]): string | null {
  const parsed = parseSlash(input);
  if (!parsed) return null;
  const cmd = commands.find((c) => c.name === parsed.name);
  if (!cmd) return null;
  return applyArgs(cmd.template, parsed.args);
}

/** True while the user is mid-typing a command NAME (a leading slash with no
 *  space yet) — the moment to show the autocomplete menu. */
export function isSlashTyping(input: string): boolean {
  return /^\/[^\s/]*$/.test(input);
}

/** Filter commands by the typed name fragment (matches name or description). */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) =>
      c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
  );
}
