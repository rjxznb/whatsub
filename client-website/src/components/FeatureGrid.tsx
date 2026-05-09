'use client';

import { useReveal } from '@/hooks/useReveal';

const FEATURES = [
  {
    title: '词汇本',
    body: '⭐ 收藏的生词跨视频汇总,CSV 导出,深链一键跳回原片对应字幕段',
    img: '/screenshots/feature-vocab.svg',
    num: '01',
  },
  {
    title: '字幕导出',
    body: '英文 / 中文 / 双语 SRT,或烧录进 mp4 三档画质也支持都不勾字幕直接流复制原视频',
    img: '/screenshots/feature-export.svg',
    num: '02',
  },
  {
    title: '字幕编辑',
    body: '行内文本和时间戳直接改、拖拽重排、加行删行修一处错就完事',
    img: '/screenshots/feature-edit.svg',
    num: '03',
  },
  {
    title: '黄底高亮 + IPA',
    body: '重点短语黄底标线、IPA 音标、TTS 一键朗读每一句都能拆开学',
    img: '/screenshots/feature-highlight.svg',
    num: '04',
  },
];

export function FeatureGrid() {
  const ref = useReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      id="features"
      className="bg-[--bg-soft] px-6 py-24 sm:px-10 sm:py-32 lg:px-16"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2
          className="reveal mb-4 max-w-[900px] font-display font-bold leading-[1.05] tracking-[-0.01em] text-ink"
          style={{ fontSize: 'clamp(40px, 6vw, 72px)' }}
        >
          比<span className="text-accent">「字幕翻译工具」</span>多走了几步路
        </h2>
        <p className="reveal reveal-delay-1 mb-12 max-w-[600px] text-base leading-[1.6] text-[--ink-soft]">
          下面这些不是核心功能,是用了之后再也回不去的小事
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, i) => (
            <div
              key={f.title}
              className={`reveal reveal-delay-${Math.min(i + 1, 4)} group relative h-[260px] overflow-hidden rounded-xl border border-[--hairline] bg-[--bg-elev]`}
            >
              {/* Default text content */}
              <div className="flex h-full flex-col justify-between p-6 transition-opacity duration-300 group-hover:opacity-0">
                <div>
                  <h3 className="mb-2 font-display text-2xl font-bold leading-tight text-ink">
                    {f.title}
                  </h3>
                  <p className="text-sm leading-[1.55] text-[--ink-soft]">{f.body}</p>
                </div>
                <div className="self-end font-display text-[2.5rem] font-bold leading-none text-[--ink-faint] opacity-30">
                  {f.num}
                </div>
              </div>
              {/* Hover screenshot overlay */}
              <div className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                <img
                  src={f.img}
                  alt={f.title}
                  className="block h-full w-full object-cover"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
