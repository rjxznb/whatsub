import type { ToolDef, PageContext } from "./types";
import { corpusBrowseTool } from "./tools/corpus_browse";
import { corpusPhraseDetailTool } from "./tools/corpus_phrase_detail";
import { listLibraryTool } from "./tools/list_library";
import { listVocabTool } from "./tools/list_vocab";

/** Tools are registered here. T14-T19 push their tools onto this array via
 *  static imports + the spread pattern; v1 keeps the registry static (no
 *  dynamic register() API to avoid plug-in surface). */
export const TOOLS: ToolDef[] = [
  corpusBrowseTool as unknown as ToolDef,
  corpusPhraseDetailTool as unknown as ToolDef,
  listLibraryTool as unknown as ToolDef,
  listVocabTool as unknown as ToolDef,
];

export function getTool(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}

export function listTools(page?: PageContext): ToolDef[] {
  if (!page) return TOOLS;
  return TOOLS.filter((t) => t.availableOn(page));
}
