interface Props {
  /** True if user has no LLM configured. Shows different copy + CTA. */
  noLlm: boolean;
  /** Suggested prompts shown when noLlm=false. */
  suggestions?: string[];
  onSuggestionClick?: (text: string) => void;
  onOpenSettings?: () => void;
}

export function EmptyState({ noLlm, suggestions, onSuggestionClick, onOpenSettings }: Props) {
  if (noLlm) {
    return (
      <div className="p-4 text-center text-zinc-300 text-sm space-y-3">
        <div className="text-3xl">🤖</div>
        <div className="text-zinc-100">AI 助手需要先配置 LLM</div>
        <div className="text-xs text-zinc-500">支持 DeepSeek / Claude / Gemini / OpenAI 等</div>
        <button
          type="button"
          onClick={onOpenSettings}
          className="px-3 py-1.5 bg-blue-500 hover:bg-blue-400 text-white rounded text-xs"
        >
          打开设置
        </button>
      </div>
    );
  }

  const defaultSuggestions = [
    "找几个 medical 场景的视频",
    "把这一段加生词本",
    "解释一下这个英语短语",
  ];
  const tips = suggestions ?? defaultSuggestions;

  return (
    <div className="p-4 text-zinc-300 text-sm space-y-3">
      <div className="text-3xl text-center">🤖</div>
      <div className="text-center text-zinc-200">AI 助手能帮你：</div>
      <ul className="text-xs text-zinc-400 space-y-1">
        <li>• 查公共语料库找视频</li>
        <li>• 加生词本 / 同步到云</li>
        <li>• 在视频里解释一段 / 出题 / 标连读</li>
      </ul>
      <div className="text-xs text-zinc-500 pt-2">试试：</div>
      <div className="space-y-1">
        {tips.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSuggestionClick?.(s)}
            className="block w-full text-left px-2 py-1.5 text-xs text-blue-300 hover:bg-zinc-800 rounded"
          >
            ▶ {s}
          </button>
        ))}
      </div>
    </div>
  );
}
