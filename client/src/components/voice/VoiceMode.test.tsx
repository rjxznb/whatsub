/**
 * Tests for VoiceMode portal component.
 *
 * VoiceConversation is mocked so we test only the React mounting,
 * store wiring, and UI surface — not the conversation loop itself.
 *
 * Portals render to document.body, so we use `document.querySelector`
 * instead of `screen` (which only searches within the render container).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { VoiceMode } from "./VoiceMode";
import { useVoiceMode } from "../../store/voiceMode";
import { useSettings } from "../../store/settings";
import { DEFAULT_SETTINGS } from "../../types/settings";

// ── Mock helpers accessible from within the vi.mock factory ──────────────────
// vi.mock factories are hoisted — only `vi` is available at hoist time, NOT
// variables declared in the test body. We store state on a module-level object
// that the factory can close over, then reset it in beforeEach.

const __mockState = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  lastHandlers: undefined as Record<string, unknown> | undefined,
};

vi.mock("../../voice/voiceConversation", () => {
  // Constructor function (works with `new`).
  function VoiceConversation(_settings: unknown, handlers: unknown) {
    __mockState.lastHandlers = handlers as Record<string, unknown>;
    return {
      start: __mockState.start,
      stop: __mockState.stop,
    };
  }
  return { VoiceConversation };
});

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __mockState.start.mockClear();
  __mockState.stop.mockClear();
  __mockState.lastHandlers = undefined;
  // Reset store states.
  useVoiceMode.setState({ open: false });
  useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true });
  // Clean up portal nodes left in body between tests.
  document.body.innerHTML = "";
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VoiceMode", () => {
  it("renders nothing when store is closed", () => {
    useVoiceMode.setState({ open: false });
    render(<VoiceMode />);
    expect(document.querySelector("[data-voice-mode]")).toBeNull();
  });

  it("renders orb container with data-voice-mode when store is open", async () => {
    useVoiceMode.setState({ open: true });

    await act(async () => {
      render(<VoiceMode />);
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(document.querySelector("[data-voice-mode]")).not.toBeNull();
    expect(__mockState.start).toHaveBeenCalledOnce();
  });

  it("shows 在听，请说… status text after onState('listening')", async () => {
    useVoiceMode.setState({ open: true });

    await act(async () => {
      render(<VoiceMode />);
      await new Promise((r) => setTimeout(r, 10));
    });

    const handlers = __mockState.lastHandlers as { onState: (s: string) => void };
    await act(async () => {
      handlers?.onState("listening");
    });

    expect(document.body.textContent).toContain("在听，请说…");
  });

  it("clicking close button calls stop() and closeVoice()", async () => {
    const closeVoiceSpy = vi.fn();
    useVoiceMode.setState({ open: true, closeVoice: closeVoiceSpy });

    await act(async () => {
      render(<VoiceMode />);
      await new Promise((r) => setTimeout(r, 10));
    });

    const voiceEl = document.querySelector("[data-voice-mode]");
    expect(voiceEl).not.toBeNull();

    const closeBtn = voiceEl!.querySelector(
      "button[aria-label='关闭语音模式']",
    ) as HTMLButtonElement | null;
    expect(closeBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(closeBtn!);
    });

    expect(__mockState.stop).toHaveBeenCalled();
    expect(closeVoiceSpy).toHaveBeenCalled();
  });
});
