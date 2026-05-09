'use client';

import { Cpu, Sparkles, Languages, Star } from 'lucide-react';
import { useReveal } from '@/hooks/useReveal';

const REASONS = [
  {
    Icon: Cpu,
    title: '本地转录',
    body: 'Whisper 模型在本机 GPU 跑,视频和音频从不离开你的电脑。Win Vulkan / Mac Metal 双平台加速,无 GPU 自动 fallback CPU。',
  },
  {
    Icon: Sparkles,
    title: '任意 LLM',
    body: 'DeepSeek / OpenAI / Claude / Kimi / Gemini 用自己的 API key。10 个预设 + 自定义。今天用 DeepSeek,明天换 Claude,不绑死任何厂商。',
  },
  {
    Icon: Languages,
    title: '真正的双语字幕',
    body: '不只是机翻挂底下。重点短语黄底高亮、IPA 音标、TTS 朗读,跟着字幕同步滚动。每一句都点得开、读得出来。',
  },
  {
    Icon: Star,
    title: '词汇本沉淀',
    body: '看到生词 ⭐ 一下,跨视频汇总。CSV 导出,深链一键跳回原片对应字幕段。每段视频都给你留下一份资产。',
  },
];

export function WhyCards() {
  const ref = useReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      id="why"
      className="bg-[--bg-soft] px-6 py-24 sm:px-10 sm:py-32 lg:px-16"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2
          className="reveal mb-14 max-w-[900px] font-display font-bold leading-[1.05] tracking-[-0.01em] text-ink"
          style={{ fontSize: 'clamp(40px, 6vw, 72px)' }}
        >
          为什么不只是<span className="text-accent">「加个字幕」</span>?
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {REASONS.map((r, i) => (
            <div
              key={r.title}
              className={`reveal reveal-delay-${Math.min(i + 1, 4)} flex min-h-[220px] flex-col rounded-xl border border-[--hairline] bg-[--bg-elev] p-6`}
            >
              <div className="mb-5 inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[--hairline] bg-[--bg-soft] text-accent">
                <r.Icon strokeWidth={1.5} className="h-5 w-5" />
              </div>
              <h3 className="mb-2 font-display text-2xl font-bold leading-tight text-ink">
                {r.title}
              </h3>
              <p className="text-sm leading-[1.6] text-[--ink-soft]">{r.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
