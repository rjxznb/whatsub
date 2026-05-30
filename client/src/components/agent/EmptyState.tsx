interface Props {
  /** True if user has no LLM configured. Shows different copy + CTA. */
  noLlm: boolean;
  /** Suggested prompts shown when noLlm=false. */
  suggestions?: string[];
  onSuggestionClick?: (text: string) => void;
  onOpenSettings?: () => void;
}

/**
 * Claude.ai-inspired empty/intro state: text-driven, no large emoji icons,
 * primary CTA in high-contrast white-on-dark.
 */
export function EmptyState({
  noLlm,
  suggestions,
  onSuggestionClick,
  onOpenSettings,
}: Props) {
  if (noLlm) {
    return (
      <div className="px-6 py-10 text-center space-y-3">
        <div className="text-sm text-zinc-300">需要先配置 LLM</div>
        <div className="text-xs text-zinc-500">
          在 Settings 里填入 API key 后回来这里
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-2 px-4 py-2 bg-zinc-100 hover:bg-white text-zinc-900 rounded text-xs font-medium"
        >
          打开设置
        </button>
      </div>
    );
  }

  const defaultSuggestions = [
    "在 YouTube 上找几个 medical 场景的视频",
    "查 \"appointment\" 这个短语在语料库的用法",
    "把上次的 GP 视频从云端拉回本地",
  ];
  const tips = suggestions ?? defaultSuggestions;

  return (
    <div className="px-6 py-8 space-y-4">
      <div className="text-sm text-zinc-300">我可以帮你：</div>
      <ul className="text-xs text-zinc-400 space-y-1.5 ml-2">
        <li>· 在 YouTube 搜视频、导入到本地</li>
        <li>· 查公共语料库的短语用法</li>
        <li>· 在视频里解释、出题、标连读</li>
        <li>· 加生词本、同步到云、管理库</li>
      </ul>
      <div className="text-xs text-zinc-500 pt-2">试试：</div>
      <div className="space-y-1">
        {tips.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSuggestionClick?.(s)}
            className="block w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800/60 rounded"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
