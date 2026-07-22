import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { ImportModal } from "./ImportModal";

const SAMPLE_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

// ── Mocks for the tauri / store surface ImportModal touches on mount ─────────
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// Capture the pipeline-event handler so tests can drive real events.
let pipelineHandler: ((e: { payload: unknown }) => void) | null = null;
const eventHandlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    eventHandlers.set(name, cb);
    if (name === "pipeline-event") pipelineHandler = cb;
    return () => {};
  }),
}));
// Controllable invoke: `import_video` never settles, so the modal stays on the
// progress view — the state the ✕-cancel tests exercise.
const invokeMock = vi.fn((cmd: string, _args?: unknown) => {
  if (cmd === "import_video") return new Promise(() => {});
  return Promise.resolve(null);
});
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
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

// Clicking ✕ must actually kill the download. Rust registers the cancel token
// BEFORE emitting Started specifically so a fast ✕ lands — but the frontend can
// only cancel if it knows the video_id, and it used to learn that from the
// `Started` event ALONE. `Started` is routinely missed: submit() reaches
// invoke("import_video") synchronously while listen() is still registering, so
// the id stayed null, cancelInFlight() early-returned, and yt-dlp kept running.
describe("ImportModal — ✕ cancels the in-flight import", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function startImport() {
    const r = render(<ImportModal onClose={() => {}} />);
    fireEvent.change(urlInput(), { target: { value: SAMPLE_URL } });
    fireEvent.click(r.getByRole("button", { name: "开始解析" }));
    await flush(); // let the listener register + progress view mount
    return r;
  }

  beforeEach(() => {
    invokeMock.mockClear();
    pipelineHandler = null;
    eventHandlers.clear();
  });

  it("cancels using an id learned from a later event when Started was missed", async () => {
    const r = await startImport();
    // Started never arrives (lost to the listen()/invoke race); progress does.
    pipelineHandler?.({
      payload: { stage: "Downloading", video_id: "vid123", percent: 42 },
    });
    await flush();

    fireEvent.click(r.getByTitle("取消下载 (Esc)"));
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("cancel_import", { videoId: "vid123" });
  });

  it("still cancels when Started did arrive", async () => {
    const r = await startImport();
    pipelineHandler?.({ payload: { stage: "Started", video_id: "vid999" } });
    await flush();

    fireEvent.click(r.getByTitle("取消下载 (Esc)"));
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("cancel_import", { videoId: "vid999" });
  });

  it("learns the id even from a Log line (the earliest event yt-dlp emits)", async () => {
    const r = await startImport();
    pipelineHandler?.({
      payload: { stage: "Log", video_id: "vidLog", source: "yt-dlp", line: "[youtube] ..." },
    });
    await flush();

    fireEvent.click(r.getByTitle("取消下载 (Esc)"));
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("cancel_import", { videoId: "vidLog" });
  });
});

describe("ImportModal — diagnosed download failures", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function startImport() {
    const r = render(<ImportModal onClose={() => {}} />);
    fireEvent.change(urlInput(), { target: { value: SAMPLE_URL } });
    fireEvent.click(r.getByRole("button", { name: "开始解析" }));
    await flush();
    return r;
  }

  beforeEach(() => {
    invokeMock.mockClear();
    pipelineHandler = null;
    eventHandlers.clear();
  });

  it("opens the YouTube login flow immediately for a bot-check error", async () => {
    const r = await startImport();
    pipelineHandler?.({
      payload: {
        stage: "Failed",
        video_id: "auth-video",
        error: "ERROR: [youtube] Sign in to confirm you’re not a bot. Use --cookies.",
      },
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("site_login_start", {
        args: {
          key: "youtube",
          label: "YouTube",
          loginUrl: "https://www.youtube.com/",
          harvestDomains: ["youtube.com", "google.com", "googleusercontent.com"],
        },
      });
    });
    expect(r.getByText("等待 YouTube 登录完成")).toBeInTheDocument();
  });

  it("automatically retries once after fresh cookies are saved", async () => {
    await startImport();
    pipelineHandler?.({
      payload: {
        stage: "Failed",
        video_id: "auth-video",
        error: "The provided account cookies are no longer valid. Please refresh your cookies.",
      },
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("site_login_start", expect.anything()));

    eventHandlers.get("site-login-success")?.({ payload: {} });

    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "import_video")).toHaveLength(2);
    });
  });

  it("shows a focused network diagnosis without opening login", async () => {
    const r = await startImport();
    pipelineHandler?.({
      payload: {
        stage: "Failed",
        video_id: "network-video",
        error: "yt-dlp exit 1: Unable to download webpage: connection timed out",
      },
    });

    await waitFor(() => expect(r.getByText("无法访问视频网站")).toBeInTheDocument());
    expect(r.queryByText("下载失败 — 排查清单")).toBeNull();
    expect(r.getByRole("button", { name: "放到后台重试" })).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "site_login_start")).toBe(false);
  });
});

describe("ImportModal — diagnosed local failures", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function startLocalImport() {
    const r = render(
      <ImportModal onClose={() => {}} initialFilePath="C:\\Videos\\sample.mp4" />,
    );
    fireEvent.click(r.getByRole("button", { name: "开始解析" }));
    await flush();
    return r;
  }

  beforeEach(() => {
    invokeMock.mockClear();
    pipelineHandler = null;
    eventHandlers.clear();
  });

  it("shows the GPU and CPU fallback diagnosis instead of the local-file checklist", async () => {
    const r = await startLocalImport();
    await act(async () => {
      pipelineHandler?.({
        payload: {
          stage: "Failed",
          video_id: "local-video",
          error:
            "whisper_gpu_cpu_fallback_failed\nGPU: whisper-cli exit -1073741819\nCPU: whisper-cli exit 3",
        },
      });
    });

    await waitFor(() => {
      expect(r.getByText("显卡加速和 CPU 兜底均失败")).toBeInTheDocument();
    });
    expect(r.queryByText("视频文件本身有问题")).toBeNull();
    expect(r.getAllByText(/已经自动切换到 CPU/).length).toBeGreaterThan(0);
  });

  it("keeps the generic local checklist for an unclassified failure", async () => {
    const r = await startLocalImport();
    await act(async () => {
      pipelineHandler?.({
        payload: {
          stage: "Failed",
          video_id: "unknown-local-video",
          error: "unexpected local pipeline failure with no known marker",
        },
      });
    });

    await waitFor(() => {
      expect(r.getByText("解析失败 — 排查清单")).toBeInTheDocument();
    });
    expect(r.getByText("视频文件本身有问题")).toBeInTheDocument();
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
