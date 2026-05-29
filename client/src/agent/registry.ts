import type { ToolDef, PageContext } from "./types";

/** Tools are registered here. T14-T19 push their tools onto this array via
 *  static imports + the spread pattern; v1 keeps the registry static (no
 *  dynamic register() API to avoid plug-in surface). */
export const TOOLS: ToolDef[] = [];

export function getTool(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}

export function listTools(page?: PageContext): ToolDef[] {
  if (!page) return TOOLS;
  return TOOLS.filter((t) => t.availableOn(page));
}
