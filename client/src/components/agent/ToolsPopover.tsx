// src/components/agent/ToolsPopover.tsx
//
// "Agent 能用的工具" reference popover, opened from a button in the chat input.
// Lists EVERY registered tool grouped by capability, with a risk badge. The
// list is driven by the registry (TOOLS) so the count is always accurate; any
// tool missing from the display map still shows in a 其它 group (never hidden).
//
// Portaled to <body> with fixed positioning computed from the trigger's rect,
// so it escapes the chat panel's overflow-hidden clipping and works in both bar
// and panel mode. Closes on Esc or an outside click.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TOOLS, getTool } from "../../agent/registry";
import type { RiskTier } from "../../agent/types";

interface Props {
  open: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** Insert a tool's prompt template into the input. `caret` is where the
   *  cursor should land (the spot the user fills in). */
  onPick: (text: string, caret: number) => void;
}

interface ToolInfo {
  label: string;
  desc: string;
  /** Prompt template inserted on click. `CARET` marks where the cursor lands
   *  (stripped before insert); omit it to drop the cursor at the end. */
  tpl: string;
}

// Invisible sentinel marking the caret position inside a template.
const CARET = "";

// Chinese display labels + click-to-insert prompt templates per tool.
// Membership/count come from the registry — this map only prettifies + maps
// each tool to a starting prompt. Keep keys aligned with the tool ids.
const TOOL_INFO: Record<string, ToolInfo> = {
  corpus_browse: { label: "查语料库", desc: "浏览公共 / 我的语料库短语", tpl: `在语料库里找关于 ${CARET} 的短语` },
  corpus_phrase_detail: { label: "短语详情", desc: "查某短语的释义 / 用法 / 标签", tpl: `查一下 "${CARET}" 这个短语的意思和用法` },
  list_library: { label: "列视频库", desc: "列出本地库（可筛场景 / 状态）", tpl: `列出我视频库里${CARET}的视频` },
  read_video_analysis: { label: "读视频内容", desc: "读某视频的字幕全文 + 重点短语", tpl: `总结一下 @${CARET} 这个视频讲了什么` },
  list_vocab: { label: "列生词本", desc: "列出收藏的生词", tpl: `看看我的生词本里有哪些词` },
  youtube_search: { label: "搜 YouTube", desc: "搜视频（只搜不下）", tpl: `在 YouTube 上搜索：${CARET}` },
  recommend_review: { label: "推荐复习", desc: "按薄弱点定位到「视频 + 几分几秒」", tpl: `我最近哪方面比较弱？给我推荐几处复习片段` },
  query_learner_profile: { label: "读学习档案", desc: "水平 / 薄弱点 / 最近错误", tpl: `看看我的学习档案（水平和薄弱点）` },
  open_video: { label: "打开视频", desc: "跳到播放页（可定位到秒）", tpl: `打开视频：${CARET}` },
  open_page: { label: "跳转页面", desc: "库 / 生词本 / 语料库 / 设置", tpl: `去${CARET}页面` },
  seek_to_time: { label: "定位时间", desc: "跳到某秒（仅播放页）", tpl: `跳到 ${CARET}` },
  jump_to_cue: { label: "跳到字幕", desc: "跳到第 N 句（仅播放页）", tpl: `跳到第 ${CARET} 句字幕` },
  start_lesson: { label: "开始精讲", desc: "生成计划逐句精讲（仅播放页）", tpl: `精讲这个视频` },
  start_roleplay: { label: "角色扮演", desc: "基于视频场景对练", tpl: `用这个视频的场景跟我角色扮演` },
  start_remediation: { label: "专项练习", desc: "针对某薄弱 pattern 练 3 分钟", tpl: `针对我的薄弱点来个 3 分钟专项练习` },
  vocab_add: { label: "加生词", desc: "收藏一个 / 多个短语", tpl: `把 "${CARET}" 加到生词本` },
  vocab_remove: { label: "删生词", desc: "移除某条生词", tpl: `从生词本删掉 "${CARET}"` },
  vocab_update_note: { label: "改笔记", desc: "改某条生词的用法笔记", tpl: `把生词 "${CARET}" 的笔记改成：` },
  sync_to_cloud: { label: "同步到云", desc: "推到云端供 iOS 查看", tpl: `把${CARET}这个视频同步到云端` },
  materialize_from_cloud: { label: "下载到本地", desc: "把云端视频拉到本地", tpl: `把云端的 ${CARET} 下载到本地` },
  import_video: { label: "导入视频", desc: "从 URL 导入（YouTube / B站 等）", tpl: `导入这个视频：${CARET}` },
  delete_video: { label: "删视频", desc: "删本地（可选同时删云端）", tpl: `删除视频：${CARET}` },
  unsync_from_cloud: { label: "取消云同步", desc: "从云端下架（保留本地）", tpl: `取消这个视频的云同步：${CARET}` },
  retranscribe_video: { label: "重新转写", desc: "用当前 whisper 重转字幕", tpl: `重新转写视频：${CARET}` },
};

const GROUPS: Array<{ title: string; ids: string[] }> = [
  // Curated "best + most-used" set, surfaced first so users meet the
  // flagship features (总结 / 精讲 / 角色扮演 / 推荐复习) before the long
  // categorized list. These ids are intentionally MOVED out of their
  // category groups below (not duplicated) so each tool still appears once.
  {
    title: "⭐ 常用 · 精选",
    ids: ["read_video_analysis", "start_lesson", "start_roleplay", "recommend_review", "youtube_search", "corpus_browse"],
  },
  {
    title: "发现 · 只读",
    ids: ["corpus_phrase_detail", "list_library", "list_vocab"],
  },
  {
    title: "私教 · 学习",
    ids: ["query_learner_profile", "start_remediation"],
  },
  { title: "导航", ids: ["open_video", "open_page", "seek_to_time", "jump_to_cue"] },
  { title: "生词本", ids: ["vocab_add", "vocab_remove", "vocab_update_note"] },
  { title: "库管理", ids: ["sync_to_cloud", "materialize_from_cloud", "import_video"] },
  { title: "高风险（需确认）", ids: ["delete_video", "unsync_from_cloud", "retranscribe_video"] },
];

function RiskBadge({ tier }: { tier: RiskTier }) {
  if (tier === "LOW") return null; // low-risk = read/jump, no badge needed
  const isHigh = tier === "HIGH";
  return (
    <span
      className={
        "ml-1.5 shrink-0 rounded px-1 py-px text-[10px] leading-none " +
        (isHigh ? "bg-rose-500/20 text-rose-300" : "bg-amber-500/20 text-amber-300")
      }
    >
      {isHigh ? "高风险" : "需确认"}
    </span>
  );
}

export function ToolsPopover({ open, anchorEl, onClose, onPick }: Props) {
  // Insert a tool's template: strip the caret sentinel, report where the cursor
  // should land, then close.
  const pick = (tpl: string) => {
    const i = tpl.indexOf(CARET);
    const text = tpl.replace(CARET, "");
    onPick(text, i >= 0 ? i : text.length);
    onClose();
  };
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);

  // Position above the trigger, left-aligned, clamped into the viewport.
  useLayoutEffect(() => {
    if (!open || !anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const width = 300;
    const margin = 8;
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin));
    const bottom = window.innerHeight - r.top + 8; // sit 8px above the button
    setPos({ left, bottom, width });
  }, [open, anchorEl]);

  // Close on Esc + outside click (ignore clicks on the trigger itself).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorEl?.contains(t)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    // capture so we beat the panel's own drag mousedown handler
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [open, anchorEl, onClose]);

  if (!open || !pos) return null;

  const groupedIds = new Set(GROUPS.flatMap((g) => g.ids));
  const leftover = TOOLS.filter((t) => !groupedIds.has(t.id)).map((t) => t.id);
  const groups = leftover.length ? [...GROUPS, { title: "其它", ids: leftover }] : GROUPS;

  return createPortal(
    <div
      ref={panelRef}
      data-no-drag
      data-agent-popover
      role="dialog"
      aria-label="Agent 能用的工具"
      className="fixed z-[120] rounded-lg border border-zinc-700 bg-zinc-900/98 backdrop-blur-xl shadow-2xl overflow-hidden flex flex-col"
      style={{ left: pos.left, bottom: pos.bottom, width: pos.width, maxHeight: "min(62vh, 460px)" }}
    >
      <div className="shrink-0 px-3 py-2 border-b border-zinc-800 text-[12px] text-zinc-400">
        点一个把指令模板填到输入框 · 共 {TOOLS.length} 个
      </div>
      <div className="min-h-0 overflow-y-auto py-1">
        {/* Input shortcuts — surface the / and @ affordances users may not know. */}
        <div className="px-2 py-1">
          <div className="px-1 py-1 text-[11px] font-medium text-zinc-500">输入技巧</div>
          <button
            type="button"
            onClick={() => pick("/")}
            title="在输入框输入 / 唤起"
            className="flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-white/5 transition-colors"
          >
            <span className="mt-px text-[13px] font-mono text-blue-300">/</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-zinc-100">快捷指令</div>
              <div className="text-[11px] text-zinc-500 leading-snug">
                打 / 调用·管理你的常用指令（可复用的提示词模板）
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => pick("@")}
            title="在输入框输入 @ 唤起"
            className="flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-white/5 transition-colors"
          >
            <span className="mt-px text-[13px] font-mono text-blue-300">@</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-zinc-100">引用视频</div>
              <div className="text-[11px] text-zinc-500 leading-snug">
                引用库里的视频，围绕它总结 / 找类似 / 出题
              </div>
            </div>
          </button>
        </div>
        {groups.map((g) => (
          <div key={g.title} className="px-2 py-1">
            <div className="px-1 py-1 text-[11px] font-medium text-zinc-500">{g.title}</div>
            {g.ids.map((id) => {
              const tool = getTool(id);
              const info = TOOL_INFO[id];
              const tpl = info?.tpl ?? info?.label ?? id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => pick(tpl)}
                  title="点击插入到输入框"
                  className="flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-white/5 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center text-[13px] text-zinc-100">
                      <span className="truncate">{info?.label ?? id}</span>
                      {tool && <RiskBadge tier={tool.riskTier} />}
                    </div>
                    <div className="text-[11px] text-zinc-500 leading-snug">
                      {info?.desc ?? tool?.description ?? ""}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
