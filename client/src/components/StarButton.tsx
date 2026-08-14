import { Star } from "lucide-react";
import { useVocabulary } from "../store/vocab";

interface Props {
  expression: string;
  meaningZh: string;
  usage: string;
  videoId: string;
  videoTitle: string;
  cueTime?: number;
  cueText?: string;
  className?: string;
  size?: "sm" | "md";
}

/**
 * Toggleable star. Filled amber when the expression is in the user's
 * vocabulary; outlined otherwise. One click toggles save/unsave.
 */
export function StarButton({
  expression,
  meaningZh,
  usage,
  videoId,
  videoTitle,
  cueTime,
  cueText,
  className = "",
  size = "sm",
}: Props) {
  const { toggle, has } = useVocabulary();
  const saved = has(expression);
  const dim = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";

  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        await toggle({
          expression,
          meaningZh,
          usage,
          videoId,
          videoTitle,
          cueTime,
          cueText,
        });
      }}
      aria-label={saved ? "已收藏，点击移除" : "收藏到我的词汇本"}
      title={saved ? "已收藏 · 点击移除" : "收藏到我的词汇本"}
      className={
        "flex h-6 w-6 items-center justify-center rounded-full transition-colors " +
        (saved
          ? "text-amber-300 hover:bg-amber-900/30"
          : "text-zinc-500 hover:bg-zinc-800 hover:text-amber-300") +
        " " +
        className
      }
    >
      <Star className={dim} fill={saved ? "currentColor" : "none"} />
    </button>
  );
}
