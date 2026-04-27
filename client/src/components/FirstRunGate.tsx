import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../store/settings";

interface Props {
  children: ReactNode;
}

export function FirstRunGate({ children }: Props) {
  const { settings, load, loaded } = useSettings();
  const [modelOk, setModelOk] = useState<boolean | null>(null);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!loaded) return;
    invoke<boolean>("whisper_model_status", { size: settings.whisperModel }).then(setModelOk);
  }, [loaded, settings.whisperModel]);

  if (!loaded || modelOk === null) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-500 flex items-center justify-center text-sm">
        加载中...
      </div>
    );
  }

  const hasLlmKey = (() => {
    if (settings.llmProvider === "openai-compatible")
      return Boolean(settings.openaiCompatible.apiKey);
    if (settings.llmProvider === "claude") return Boolean(settings.claude.apiKey);
    return Boolean(settings.gemini.apiKey);
  })();

  if (!hasLlmKey || !modelOk) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-2xl font-semibold">欢迎使用 Get Video</h1>
          <p className="text-zinc-400 text-sm">
            首次启动需要：
            {!hasLlmKey && <span className="block">· 配置 LLM API Key</span>}
            {!modelOk && (
              <span className="block">· 下载 Whisper 模型 ({settings.whisperModel})</span>
            )}
          </p>
          <Link
            to="/settings"
            className="inline-block px-5 py-2 bg-blue-500 text-black font-medium rounded"
          >
            进入设置
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
