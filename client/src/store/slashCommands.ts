// src/store/slashCommands.ts
//
// User-defined slash commands — reusable prompt templates invoked with
// "/name args" in the chat input (Claude-Code-style). A command's `template`
// may contain `$ARGUMENTS`, replaced by whatever the user typed after the name;
// the expanded prompt is sent to the normal agent (no separate engine — the
// "workflow" is just the prompt). Persisted to localStorage (small, offline).

import { create } from "zustand";

export interface SlashCommand {
  id: string;
  /** Command name without the leading slash, e.g. "找视频" (no spaces). */
  name: string;
  description: string;
  /** Prompt template; `$ARGUMENTS` is substituted on use. */
  template: string;
}

const KEY = "agent.slashCommands";

// Shipped examples so the menu isn't empty on first use.
export const SEED_COMMANDS: SlashCommand[] = [
  {
    id: "seed-find",
    name: "找视频",
    description: "按场景搜 YouTube 并预览",
    template:
      "在 YouTube 上搜索 $ARGUMENTS 相关的英语学习视频，挑时长 3-8 分钟的列出来，配上封面让我预览。",
  },
  {
    id: "seed-review",
    name: "复习",
    description: "按薄弱点推荐复习片段",
    template:
      "我最近哪方面比较弱？针对 $ARGUMENTS 给我推荐几处复习片段（没指定就按我整体薄弱点来），定位到具体视频和时间点。",
  },
  {
    id: "seed-explain",
    name: "讲解",
    description: "讲解一段英文",
    template:
      "用中文详细讲解这段英文的意思、地道用法和语气，并指出值得记的表达：$ARGUMENTS",
  },
];

function load(): SlashCommand[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return SEED_COMMANDS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (c): c is SlashCommand =>
          c && typeof c.id === "string" && typeof c.name === "string" && typeof c.template === "string",
      );
    }
  } catch {
    /* ignore — fall back to seeds */
  }
  return SEED_COMMANDS;
}

function persist(commands: SlashCommand[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(commands));
  } catch {
    /* ignore */
  }
}

function genId(): string {
  return "cmd_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

interface SlashStore {
  commands: SlashCommand[];
  add: (c: Omit<SlashCommand, "id">) => void;
  update: (id: string, patch: Partial<Omit<SlashCommand, "id">>) => void;
  remove: (id: string) => void;
}

export const useSlashCommands = create<SlashStore>((set, get) => ({
  commands: load(),
  add: (c) => {
    const next = [...get().commands, { ...c, id: genId() }];
    persist(next);
    set({ commands: next });
  },
  update: (id, patch) => {
    const next = get().commands.map((c) => (c.id === id ? { ...c, ...patch } : c));
    persist(next);
    set({ commands: next });
  },
  remove: (id) => {
    const next = get().commands.filter((c) => c.id !== id);
    persist(next);
    set({ commands: next });
  },
}));
