'use client';

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { useReveal } from '@/hooks/useReveal';

const QUESTIONS: { q: string; a: string }[] = [
  {
    q: '激活授权码后多久能用?',
    a: '立即可用。在线验证一次后软件完全离线运行,以后开机不再联网。一份授权码可在 3 台个人设备上同时使用,永久有效。',
  },
  {
    q: '国内能不能正常激活?',
    a: '可以。激活服务器在国内(阿里云北京,eversay.cc 已备案),通常 200ms 内完成激活。激活成功后软件完全离线运行,不再联网。',
  },
  {
    q: '3 台设备用满了怎么办?',
    a: '联系客服(小红书私信)免费释放任意一台旧设备的槽位,然后在新设备上重新激活即可。不限次数。',
  },
  {
    q: 'macOS 双击提示「已损坏」怎么办?',
    a: '请把 .app 拖进「应用程序」文件夹再打开。直接从「下载」目录打开会触发 macOS App Translocation,导致首次启动报错。已通过 Apple Developer ID 签名 + 公证,放进 Applications 后无任何弹窗。',
  },
  {
    q: '为什么需要 LLM API key?',
    a: '翻译用你自己的 LLM 账号调,按 token 付费。DeepSeek 最便宜(约 ¥0.001/千 tokens),整片 22 分钟视频翻译通常几分钱。10 个预设(DeepSeek/OpenAI/Claude/Kimi/Gemini/智谱/Qwen/SiliconFlow/Ollama/自定义)切换零成本。',
  },
  {
    q: '视频会不会上传?',
    a: '不会。Whisper 转录在你的 GPU 上跑,LLM 翻译只发送字幕文本(不发送音视频)。隐私敏感的可以用 Ollama 把 LLM 也跑本地,实现完全离线。',
  },
  {
    q: '能不能退款?',
    a: '不支持退款。数字商品售出不退,购买前可以下载试用免费档位,体验完所有核心功能后再决定。',
  },
];

export function FAQ() {
  const ref = useReveal<HTMLElement>();
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <section
      ref={ref}
      id="faq"
      className="bg-bg px-6 py-24 sm:px-10 sm:py-32 lg:px-16"
    >
      <div className="mx-auto max-w-[900px]">
        <h2
          className="reveal mb-14 font-display font-bold leading-[1.05] tracking-[-0.01em] text-ink"
          style={{ fontSize: 'clamp(40px, 6vw, 72px)' }}
        >
          常见问题。
        </h2>
        <div className="reveal reveal-delay-1 border-t border-[--hairline]">
          {QUESTIONS.map((qa, i) => {
            const open = openIdx === i;
            return (
              <div key={i} className="border-b border-[--hairline]">
                <button
                  type="button"
                  onClick={() => setOpenIdx(open ? null : i)}
                  className="flex w-full items-center justify-between gap-4 py-5 text-left transition-colors hover:bg-white/[0.02]"
                  aria-expanded={open}
                >
                  <span className="font-display text-xl font-bold text-ink sm:text-2xl">
                    {qa.q}
                  </span>
                  <ChevronDown
                    className={`h-5 w-5 shrink-0 text-[--ink-muted] transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
                    strokeWidth={1.5}
                  />
                </button>
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-out"
                  style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
                >
                  <div className="overflow-hidden">
                    <p className="pb-6 text-base leading-[1.7] text-[--ink-soft]">
                      {qa.a}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
