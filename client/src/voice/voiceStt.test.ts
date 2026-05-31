import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../store/settings";
import { transcribeVoice } from "./voiceStt";

vi.mock("@tauri-apps/api/core");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transcribeVoice", () => {
  it("invokes voice_transcribe with the settings whisperModel and lang=en", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue("hello world");

    // Seed settings with a specific whisperModel
    useSettings.setState({
      settings: {
        ...useSettings.getState().settings,
        whisperModel: "small",
      },
    });

    const result = await transcribeVoice("AAAA");

    expect(mockInvoke).toHaveBeenCalledWith("voice_transcribe", {
      wavBase64: "AAAA",
      model: "small",
      lang: "en",
    });
    expect(result).toBe("hello world");
  });

  it("passes the wav_base64 argument unchanged", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue("");

    useSettings.setState({
      settings: {
        ...useSettings.getState().settings,
        whisperModel: "base",
      },
    });

    const fakeB64 = "dGVzdA=="; // btoa("test")
    await transcribeVoice(fakeB64);

    expect(mockInvoke).toHaveBeenCalledWith("voice_transcribe", {
      wavBase64: fakeB64,
      model: "base",
      lang: "en",
    });
  });

  it("uses model from settings, not a hardcoded value", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue("ok");

    for (const size of ["tiny", "medium", "large-v3"] as const) {
      useSettings.setState({
        settings: {
          ...useSettings.getState().settings,
          whisperModel: size,
        },
      });

      await transcribeVoice("X");

      expect(mockInvoke).toHaveBeenLastCalledWith("voice_transcribe", {
        wavBase64: "X",
        model: size,
        lang: "en",
      });
    }
  });

  it("propagates errors from invoke", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockRejectedValue(new Error("model not downloaded: tiny"));

    useSettings.setState({
      settings: {
        ...useSettings.getState().settings,
        whisperModel: "tiny",
      },
    });

    await expect(transcribeVoice("X")).rejects.toThrow("model not downloaded");
  });

  it("always passes lang: 'en'", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue("");

    useSettings.setState({
      settings: {
        ...useSettings.getState().settings,
        whisperModel: "base",
      },
    });

    await transcribeVoice("X");

    const call = mockInvoke.mock.calls[0];
    expect((call[1] as Record<string, unknown>)["lang"]).toBe("en");
  });
});
