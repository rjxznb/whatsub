import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ImportModal } from "./ImportModal";

const SAMPLE_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

// ── Mocks for the tauri / store surface ImportModal touches on mount ─────────
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../store/appDialog", () => ({ notify: vi.fn() }));
vi.mock("../lib/cookieStatus", () => ({
  cookieStatusFor: vi.fn().mockResolvedValue(null),
}));
vi.mock("./SiteLoginModal", () => ({ SiteLoginModal: () => null }));

const settingsState = { settings: { whisperModel: "small", cookieSource: "system" } };
vi.mock("../store/settings", () => {
  const useSettings = () => settingsState;
  useSettings.getState = () => settingsState;
  return { useSettings };
});
vi.mock("../store/library", () => ({
  useLibrary: () => ({ reload: vi.fn() }),
}));
vi.mock("../store/analysis", () => ({
  useAnalysis: () => ({ startFor: vi.fn() }),
}));

function urlInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('[data-tour="url-input"]')!;
}

describe("ImportModal — onboarding sample-URL affordance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("offers the sample URL as placeholder (ghost text) during onboarding", () => {
    render(<ImportModal onClose={() => {}} showSampleLink />);
    expect(urlInput().placeholder).toBe(SAMPLE_URL);
  });

  it("shows a Tab-to-fill affordance INSIDE the input, not a button below it", () => {
    render(<ImportModal onClose={() => {}} showSampleLink />);
    // The affordance carries the tour anchor so the tour can point at it,
    // and sits within the highlighted input (not obscured by the tooltip).
    const btn = document.querySelector('[data-tour="sample-link"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toMatch(/Tab/);
  });

  it("fills the sample URL when the affordance is clicked", () => {
    render(<ImportModal onClose={() => {}} showSampleLink />);
    fireEvent.click(document.querySelector('[data-tour="sample-link"]')!);
    expect(urlInput().value).toBe(SAMPLE_URL);
  });

  it("fills the sample URL when Tab is pressed on the empty field", () => {
    render(<ImportModal onClose={() => {}} showSampleLink />);
    const input = urlInput();
    const evt = fireEvent.keyDown(input, { key: "Tab" });
    expect(evt).toBe(false); // preventDefault was called → focus does NOT move
    expect(input.value).toBe(SAMPLE_URL);
  });

  it("does NOT hijack Tab once the field already has text", () => {
    render(<ImportModal onClose={() => {}} showSampleLink />);
    const input = urlInput();
    fireEvent.change(input, { target: { value: "https://youtu.be/abc" } });
    const evt = fireEvent.keyDown(input, { key: "Tab" });
    expect(evt).toBe(true); // default NOT prevented → Tab moves focus normally
    expect(input.value).toBe("https://youtu.be/abc");
  });

  it("once filled, the in-input affordance disappears (nothing left to fill)", () => {
    render(<ImportModal onClose={() => {}} showSampleLink />);
    fireEvent.keyDown(urlInput(), { key: "Tab" });
    expect(document.querySelector('[data-tour="sample-link"]')).toBeNull();
  });
});

describe("ImportModal — normal (non-onboarding) use", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the generic placeholder and no sample affordance", () => {
    render(<ImportModal onClose={() => {}} />);
    expect(urlInput().placeholder).not.toBe(SAMPLE_URL);
    expect(document.querySelector('[data-tour="sample-link"]')).toBeNull();
  });

  it("leaves Tab as plain focus navigation", () => {
    render(<ImportModal onClose={() => {}} />);
    const input = urlInput();
    const evt = fireEvent.keyDown(input, { key: "Tab" });
    expect(evt).toBe(true); // not prevented
    expect(input.value).toBe("");
  });
});
