import type { ToolDef, PageContext } from "./types";
import { corpusBrowseTool } from "./tools/corpus_browse";
import { corpusPhraseDetailTool } from "./tools/corpus_phrase_detail";
import { listLibraryTool } from "./tools/list_library";
import { listVocabTool } from "./tools/list_vocab";
import { openVideoTool } from "./tools/open_video";
import { openPageTool } from "./tools/open_page";
import { seekToTimeTool } from "./tools/seek_to_time";
import { jumpToCueTool } from "./tools/jump_to_cue";
import { explainPassageTool } from "./tools/explain_passage";
import { generateQuizTool } from "./tools/generate_quiz";
import { markLiaisonsTool } from "./tools/mark_liaisons";
import { translatePhraseTool } from "./tools/translate_phrase";
import { vocabAddTool } from "./tools/vocab_add";
import { vocabRemoveTool } from "./tools/vocab_remove";
import { vocabUpdateNoteTool } from "./tools/vocab_update_note";
import { syncToCloudTool } from "./tools/sync_to_cloud";
import { materializeFromCloudTool } from "./tools/materialize_from_cloud";
import { importVideoTool } from "./tools/import_video";
import { deleteVideoTool } from "./tools/delete_video";
import { unsyncFromCloudTool } from "./tools/unsync_from_cloud";
import { retranscribeVideoTool } from "./tools/retranscribe_video";

/** Tools are registered here. T14-T19 push their tools onto this array via
 *  static imports + the spread pattern; v1 keeps the registry static (no
 *  dynamic register() API to avoid plug-in surface). */
export const TOOLS: ToolDef[] = [
  // discovery (T14)
  corpusBrowseTool as unknown as ToolDef,
  corpusPhraseDetailTool as unknown as ToolDef,
  listLibraryTool as unknown as ToolDef,
  listVocabTool as unknown as ToolDef,
  // navigation (T15)
  openVideoTool as unknown as ToolDef,
  openPageTool as unknown as ToolDef,
  seekToTimeTool as unknown as ToolDef,
  jumpToCueTool as unknown as ToolDef,
  // in-video AI (T16)
  explainPassageTool as unknown as ToolDef,
  generateQuizTool as unknown as ToolDef,
  markLiaisonsTool as unknown as ToolDef,
  translatePhraseTool as unknown as ToolDef,
  // vocab write (T17)
  vocabAddTool as unknown as ToolDef,
  vocabRemoveTool as unknown as ToolDef,
  vocabUpdateNoteTool as unknown as ToolDef,
  // library write (T18)
  syncToCloudTool as unknown as ToolDef,
  materializeFromCloudTool as unknown as ToolDef,
  importVideoTool as unknown as ToolDef,
  // library HIGH (T19)
  deleteVideoTool as unknown as ToolDef,
  unsyncFromCloudTool as unknown as ToolDef,
  retranscribeVideoTool as unknown as ToolDef,
];

export function getTool(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}

export function listTools(page?: PageContext): ToolDef[] {
  if (!page) return TOOLS;
  return TOOLS.filter((t) => t.availableOn(page));
}
