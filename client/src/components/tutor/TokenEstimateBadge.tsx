import { DEFAULT_VENDOR_PRICING, approxYuan } from "../../tutor/tokenEstimator";

interface Props {
  tokens: number;
  vendorId: string;
  vendorLabel: string;
}

export function TokenEstimateBadge({ tokens, vendorId, vendorLabel }: Props) {
  const pricing = DEFAULT_VENDOR_PRICING[vendorId];
  return (
    <div className="text-xs text-zinc-400 flex items-center gap-2">
      <span className="font-mono text-zinc-300">
        预计 ~{tokens.toLocaleString()} tokens
      </span>
      <span className="text-zinc-600">·</span>
      <span>当前 LLM: {vendorLabel}</span>
      {pricing && (
        <>
          <span className="text-zinc-600">·</span>
          <span>≈ ¥{approxYuan(tokens, pricing).toFixed(2)}</span>
        </>
      )}
    </div>
  );
}
