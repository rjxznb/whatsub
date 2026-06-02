// src/components/AddCorpusPhraseDialog.tsx
//
// Desktop form to add a phrase to the PERSONAL corpus (个人语料库) — the same
// thing the browser plugin's 划词 flow does, but typed in by hand. Fields match
// the backend CorpusContributeRequest. Submit is blocked when the quota is full.

import { useState } from "react";
import { X, Loader2 } from "lucide-react";
import { createPortal } from "react-dom";
import {
  corpusContribute,
  CorpusContributeError,
  type CorpusSource,
} from "../lib/api/corpus";
import { parseYouTubeUrl } from "./YouTubeEmbed";
import { SCENE_ORDER, SCENE_LABELS } from "../lib/scenes";

interface Props {
  /** True when used >= limit — submit is blocked. */
  quotaFull: boolean;
  onClose: () => void;
  /** Called after a successful add so the caller can refresh list + quota. */
  onAdded: () => void;
}

/** Build the backend `source` from an optional URL. YouTube → youtube (+ ts);
 *  any other URL → webpage; empty → a desktop-manual placeholder (the backend
 *  requires a valid url + a kind in [youtube, webpage, pdf]). */
function buildSource(url: string, title: string): CorpusSource {
  const trimmed = url.trim();
  if (!trimmed) {
    return { kind: "webpage", url: "https://whatsub.eversay.cc/desktop", title: "桌面手动添加" };
  }
  const yt = parseYouTubeUrl(trimmed);
  if (yt) {
    return {
      kind: "youtube",
      url: trimmed,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(yt.startSec ? { timestampSec: yt.startSec } : {}),
    };
  }
  return {
    kind: "webpage",
    url: trimmed,
    ...(title.trim() ? { title: title.trim() } : {}),
  };
}

const REASON_MESSAGES: Record<string, string> = {
  quota_exceeded: "个人语料额度已满，无法继续添加。",
  empty_phrase: "短语不能为空。",
  missing_fields: "请填写短语和例句。",
  invalid_url: "来源链接格式不对。",
  blocklist_match: "这个短语不允许添加。",
  auth_required: "云端未连接，请稍后重试。",
  bad_token: "登录已过期，请重新打开应用。",
  rate_limited: "操作太频繁，请稍后再试。",
};

export function AddCorpusPhraseDialog({ quotaFull, onClose, onAdded }: Props) {
  const [phrase, setPhrase] = useState("");
  const [context, setContext] = useState("");
  const [meaning, setMeaning] = useState("");
  const [usage, setUsage] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [customTag, setCustomTag] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = phrase.trim().length > 0 && context.trim().length > 0 && !busy && !quotaFull;

  const toggleTag = (t: string) =>
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const addCustomTag = () => {
    const t = customTag.trim();
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t]);
    setCustomTag("");
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      await corpusContribute({
        phraseRaw: phrase.trim(),
        contextSentence: context.trim(),
        source: buildSource(sourceUrl, sourceTitle),
        ...(meaning.trim() ? { meaningZh: meaning.trim() } : {}),
        ...(usage.trim() ? { usageNote: usage.trim() } : {}),
        ...(tags.length ? { tags } : {}),
      });
      onAdded();
      onClose();
    } catch (e) {
      const reason = e instanceof CorpusContributeError ? e.reason : String(e);
      setErr(REASON_MESSAGES[reason] ?? `添加失败：${reason}`);
      setBusy(false);
    }
  };

  // Custom (non-scene) tags the user already picked, shown after the scene grid.
  const customSelected = tags.filter((t) => !SCENE_ORDER.includes(t as never));

  return createPortal(
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="text-sm font-medium text-zinc-100">添加到个人语料库</div>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {quotaFull && (
            <div className="rounded-md bg-amber-500/15 px-3 py-2 text-xs text-amber-300">
              个人语料额度已满，无法添加。升级订阅可把上限提到 1000。
            </div>
          )}

          <Field label="短语 *">
            <input
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="如：save up"
              className={INPUT}
            />
          </Field>

          <Field label="例句 / 上下文 *">
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={2}
              placeholder="短语出现的完整句子"
              className={INPUT + " resize-none"}
            />
          </Field>

          <Field label="中文释义">
            <input value={meaning} onChange={(e) => setMeaning(e.target.value)} placeholder="选填" className={INPUT} />
          </Field>

          <Field label="用法说明">
            <textarea
              value={usage}
              onChange={(e) => setUsage(e.target.value)}
              rows={2}
              placeholder="选填"
              className={INPUT + " resize-none"}
            />
          </Field>

          <Field label="标签">
            <div className="flex flex-wrap gap-1.5">
              {SCENE_ORDER.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleTag(s)}
                  className={
                    "rounded-full px-2 py-0.5 text-[11px] transition-colors " +
                    (tags.includes(s)
                      ? "bg-amber-400/20 text-amber-200 border border-amber-400/50"
                      : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-200")
                  }
                >
                  {SCENE_LABELS[s]}
                </button>
              ))}
              {customSelected.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTag(t)}
                  className="rounded-full border border-amber-400/50 bg-amber-400/20 px-2 py-0.5 text-[11px] text-amber-200"
                >
                  {t} ✕
                </button>
              ))}
            </div>
            <div className="mt-1.5 flex gap-2">
              <input
                value={customTag}
                onChange={(e) => setCustomTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomTag();
                  }
                }}
                placeholder="自定义标签，回车添加"
                className={INPUT + " text-xs"}
              />
            </div>
          </Field>

          <Field label="来源链接（选填）">
            <input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="YouTube / 网页链接，留空则标记为手动添加"
              className={INPUT}
            />
            {sourceUrl.trim() && (
              <input
                value={sourceTitle}
                onChange={(e) => setSourceTitle(e.target.value)}
                placeholder="来源标题（选填）"
                className={INPUT + " mt-1.5 text-xs"}
              />
            )}
          </Field>

          {err && <div className="text-xs text-rose-300">{err}</div>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-black transition-colors hover:bg-blue-400 disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            添加
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs text-zinc-400">{label}</div>
      {children}
    </div>
  );
}
