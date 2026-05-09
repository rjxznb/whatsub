'use client';

import { useReveal } from '@/hooks/useReveal';

const STEPS = [
  {
    num: '01',
    title: '导入',
    body: '粘 YouTube 链接,或拖一个本地 mp4 进来。yt-dlp + ffmpeg 自动跑,Cookies 也准备好了应付年龄/地区限制。',
    img: '/screenshots/step-1.svg',
    alt: '导入视频界面',
  },
  {
    num: '02',
    title: '本地识别',
    body: 'Whisper 模型在你的 GPU 上跑,5 个档位选择(75 MB → 3 GB)。识别完整 22 分钟视频通常 1-3 分钟。视频和音频从不上传。',
    img: '/screenshots/step-2.svg',
    alt: 'Whisper 转录进度',
  },
  {
    num: '03',
    title: '双语播放',
    body: '字幕、词汇、播放器、词汇本在同一个 Player 页里。生词 ⭐ 一下进词汇本,字幕里黄底高亮的关键短语点开就有 IPA + 注释 + TTS 朗读。',
    img: '/screenshots/step-3.svg',
    alt: '双语播放界面',
  },
];

export function HowSteps() {
  const ref = useReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      id="how"
      className="bg-bg px-6 py-24 sm:px-10 sm:py-32 lg:px-16"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2
          className="reveal mb-16 max-w-[900px] font-display font-bold leading-[1.05] tracking-[-0.01em] text-ink"
          style={{ fontSize: 'clamp(40px, 6vw, 72px)' }}
        >
          三步,从一段视频走到一份<span className="text-accent">词汇</span>。
        </h2>
        <div className="space-y-24 lg:space-y-32">
          {STEPS.map((step, i) => {
            const isEven = i % 2 === 0;
            return (
              <div
                key={step.num}
                className={`reveal reveal-delay-${Math.min(i + 1, 4)} grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16`}
              >
                {/* Text */}
                <div className={isEven ? 'lg:order-1' : 'lg:order-2'}>
                  <span
                    className="mb-3 block font-display font-bold leading-none text-[--ink-faint]"
                    style={{ fontSize: 'clamp(48px, 6vw, 80px)' }}
                  >
                    {step.num}
                  </span>
                  <h3
                    className="mb-5 font-display font-bold leading-[1.1] text-ink"
                    style={{ fontSize: 'clamp(32px, 4.5vw, 56px)' }}
                  >
                    {step.title}
                  </h3>
                  <p className="max-w-[480px] text-base leading-[1.7] text-[--ink-soft]">
                    {step.body}
                  </p>
                </div>
                {/* Screenshot */}
                <div
                  className={
                    'overflow-hidden rounded-xl border border-[--hairline] bg-[--bg-elev] ' +
                    (isEven ? 'lg:order-2' : 'lg:order-1')
                  }
                >
                  <img
                    src={step.img}
                    alt={step.alt}
                    className="block h-auto w-full"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
