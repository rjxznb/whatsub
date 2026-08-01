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
let deferPipelineListenerRegistration = false;
let resolveDeferredPipelineListener: (() => void) | null = null;
let deferSiteLoginListenerRegistrations = false;
const deferredSiteLoginUnlistenResolvers: Array<() => void> = [];
const lateSiteLoginUnlistenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "pipeline-event" && deferPipelineListenerRegistration) {
      return new Promise<() => void>((resolve) => {
        resolveDeferredPipelineListener = () => {
          eventHandlers.set(name, cb);
          pipelineHandler = cb;
          resolve(() => {});
        };
      });
    }
    eventHandlers.set(name, cb);
    if (name === "pipeline-event") pipelineHandler = cb;
    if (
      deferSiteLoginListenerRegistrations &&
      (name === "site-login-success" || name === "site-login-cancelled")
    ) {
      return new Promise<() => void>((resolve) => {
        deferredSiteLoginUnlistenResolvers.push(() => resolve(lateSiteLoginUnlistenMock));
      });
    }
    return Promise.resolve(() => {});
  }),
}));
// Controllable invoke: `import_video` never settles, so the modal stays on the
// progress view — the state the ✕-cancel tests exercise.
let deferSiteLoginCancel = false;
let resolveDeferredSiteLoginCancel: (() => void) | null = null;
let deferImportCancel = false;
let rejectImportCancel: Error | null = null;
let resolveDeferredImportCancel: (() => void) | null = null;
let rejectNextImportVideo: Error | null = null;
let importPreflightResult: {
  videoId: string;
  state: "missing" | "existing" | "running";
  title?: string;
} = { videoId: "jNQXAC9IVRw", state: "missing" };
const invokeMock = vi.fn((cmd: string, _args?: unknown) => {
  if (cmd === "import_preflight") return Promise.resolve(importPreflightResult);
  if (cmd === "import_video") {
    if (rejectNextImportVideo) {
      const error = rejectNextImportVideo;
      rejectNextImportVideo = null;
      return Promise.reject(error);
    }
    return new Promise(() => {});
  }
  if (cmd === "cancel_import") {
    if (rejectImportCancel) return Promise.reject(rejectImportCancel);
    if (deferImportCancel) {
      return new Promise<void>((resolve) => {
        resolveDeferredImportCancel = resolve;
      });
    }
  }
  if (cmd === "site_login_cancel" && deferSiteLoginCancel) {
    return new Promise<void>((resolve) => {
      resolveDeferredSiteLoginCancel = resolve;
    });
  }
  return Promise.resolve(null);
});
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: (cmd: string, args?: unknown) =>
    args === undefined ? invokeMock(cmd) : invokeMock(cmd, args),
}));
const appDialogMocks = vi.hoisted(() => ({
  notify: vi.fn(),
  confirmDialog: vi.fn(),
}));
vi.mock("../store/appDialog", () => appDialogMocks);
vi.mock("../lib/cookieStatus", () => ({
  cookieStatusFor: vi.fn().mockResolvedValue(null),
}));
const llmQuotaMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api/quota", () => ({
  llmQuota: llmQuotaMock,
}));
vi.mock("./SiteLoginModal", () => ({ SiteLoginModal: () => null }));

const settingsState = {
  settings: {
    whisperModel: "small",
    cookieSource: "system",
    vendorId: "deepseek",
  },
};
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

function resolveDeferredSiteLoginListeners() {
  deferredSiteLoginUnlistenResolvers.splice(0).forEach((resolve) => resolve());
}

beforeEach(() => {
  settingsState.settings.vendorId = "deepseek";
  llmQuotaMock.mockReset();
  llmQuotaMock.mockResolvedValue({
    used: 0,
    limit: 5_000_000,
    requestCount: 0,
    tier: "pro",
    periodResetAt: Date.UTC(2026, 7, 1),
  });
  deferSiteLoginListenerRegistrations = false;
  deferredSiteLoginUnlistenResolvers.splice(0);
  lateSiteLoginUnlistenMock.mockClear();
  deferSiteLoginCancel = false;
  resolveDeferredSiteLoginCancel = null;
  deferImportCancel = false;
  rejectImportCancel = null;
  resolveDeferredImportCancel = null;
  rejectNextImportVideo = null;
  importPreflightResult = { videoId: "jNQXAC9IVRw", state: "missing" };
  appDialogMocks.confirmDialog.mockReset();
  appDialogMocks.confirmDialog.mockResolvedValue(false);
});

describe("ImportModal — existing video confirmation", () => {
  beforeEach(() => invokeMock.mockClear());

  function renderWithUrl(onClose: () => void = () => {}) {
    const r = render(<ImportModal onClose={onClose} />);
    fireEvent.change(urlInput(), { target: { value: SAMPLE_URL } });
    return r;
  }

  it("starts a missing video with overwrite disabled", async () => {
    const r = renderWithUrl();
    fireEvent.click(r.getByRole("button", { name: "开始解析" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("import_video", {
        req: expect.objectContaining({ overwrite: false }),
      }),
    );
    expect(appDialogMocks.confirmDialog).not.toHaveBeenCalled();
  });

  it("keeps the form open when replacement is cancelled", async () => {
    importPreflightResult = {
      videoId: "jNQXAC9IVRw",
      state: "existing",
      title: "Me at the zoo",
    };
    appDialogMocks.confirmDialog.mockResolvedValue(false);
    const r = renderWithUrl();
    fireEvent.click(r.getByRole("button", { name: "开始解析" }));

    await waitFor(() =>
      expect(appDialogMocks.confirmDialog).toHaveBeenCalledWith(
        expect.stringContaining("Me at the zoo"),
        expect.objectContaining({
          title: "视频已存在",
          okText: "覆盖并重新解析",
          danger: true,
        }),
      ),
    );
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "import_video")).toBe(false);
    expect(urlInput().value).toBe(SAMPLE_URL);
  });

  it("starts a confirmed replacement with overwrite enabled", async () => {
    importPreflightResult = {
      videoId: "jNQXAC9IVRw",
      state: "existing",
      title: "Me at the zoo",
    };
    appDialogMocks.confirmDialog.mockResolvedValue(true);
    const r = renderWithUrl();
    fireEvent.click(r.getByRole("button", { name: "开始解析" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("import_video", {
        req: expect.objectContaining({ overwrite: true, background: false }),
      }),
    );
  });

  it("coalesces rapid replacement submits into one confirmation and one import", async () => {
    importPreflightResult = {
      videoId: "jNQXAC9IVRw",
      state: "existing",
      title: "Me at the zoo",
    };
    let resolveConfirm!: (value: boolean) => void;
    appDialogMocks.confirmDialog.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    const r = renderWithUrl();
    const button = r.getByRole("button", { name: "开始解析" });

    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(appDialogMocks.confirmDialog).toHaveBeenCalledTimes(1));
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "import_preflight"),
    ).toHaveLength(1);

    resolveConfirm(true);
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "import_video"),
      ).toHaveLength(1),
    );
  });

  it("keeps confirmed overwrite authorization for a background import", async () => {
    importPreflightResult = {
      videoId: "jNQXAC9IVRw",
      state: "existing",
      title: "Me at the zoo",
    };
    appDialogMocks.confirmDialog.mockResolvedValue(true);
    const onClose = vi.fn();
    const r = renderWithUrl(onClose);
    fireEvent.click(r.getByRole("button", { name: "后台下载" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("import_video", {
        req: expect.objectContaining({ overwrite: true, background: true }),
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not offer overwrite while the same video is running", async () => {
    importPreflightResult = {
      videoId: "jNQXAC9IVRw",
      state: "running",
      title: "Me at the zoo",
    };
    const r = renderWithUrl();
    fireEvent.click(r.getByRole("button", { name: "开始解析" }));

    expect(
      await r.findByText("该视频正在下载或解析，请等待当前任务完成。"),
    ).toBeInTheDocument();
    expect(appDialogMocks.confirmDialog).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "import_video")).toBe(false);
  });

  it("turns a backend duplicate race into the same confirmation flow", async () => {
    rejectNextImportVideo = new Error("video_exists:jNQXAC9IVRw");
    appDialogMocks.confirmDialog.mockResolvedValue(true);
    const r = renderWithUrl();
    fireEvent.click(r.getByRole("button", { name: "开始解析" }));

    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "import_video");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.[1]).toEqual({
        req: expect.objectContaining({ overwrite: true }),
      });
    });
    expect(appDialogMocks.confirmDialog).toHaveBeenCalledTimes(1);
  });
});

describe("ImportModal — managed AI quota preflight", () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it("blocks import before download when managed Pro quota is exhausted", async () => {
    settingsState.settings.vendorId = "whatsub-managed";
    llmQuotaMock.mockResolvedValue({
      used: 5_000_000,
      limit: 5_000_000,
      requestCount: 100,
      tier: "pro",
      periodResetAt: Date.UTC(2026, 7, 1),
    });
    const r = render(<ImportModal onClose={() => {}} />);
    fireEvent.change(urlInput(), { target: { value: SAMPLE_URL } });

    fireEvent.click(r.getByRole("button", { name: "开始解析" }));

    expect(await r.findByText(/本月 AI 额度已用完/)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "import_video")).toBe(false);
  });

  it("skips quota lookup for a user-supplied API provider", async () => {
    const r = render(<ImportModal onClose={() => {}} />);
    fireEvent.change(urlInput(), { target: { value: SAMPLE_URL } });

    fireEvent.click(r.getByRole("button", { name: "开始解析" }));

    await waitFor(() =>
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "import_video")).toBe(true),
    );
    expect(llmQuotaMock).not.toHaveBeenCalled();
  });

  it("continues importing when the best-effort quota lookup fails", async () => {
    settingsState.settings.vendorId = "whatsub-managed";
    llmQuotaMock.mockRejectedValue(new Error("offline"));
    const r = render(<ImportModal onClose={() => {}} />);
    fireEvent.change(urlInput(), { target: { value: SAMPLE_URL } });

    fireEvent.click(r.getByRole("button", { name: "开始解析" }));

    await waitFor(() =>
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "import_video")).toBe(true),
    );
  });
});

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

  async function startImport(onClose: () => void = () => {}) {
    const r = render(<ImportModal onClose={onClose} />);
    fireEvent.change(urlInput(), { target: { value: SAMPLE_URL } });
    fireEvent.click(r.getByRole("button", { name: "开始解析" }));
    await flush(); // let the listener register + progress view mount
    return r;
  }

  beforeEach(() => {
    invokeMock.mockClear();
    pipelineHandler = null;
    deferPipelineListenerRegistration = false;
    resolveDeferredPipelineListener = null;
    eventHandlers.clear();
  });

  it("does not invoke Rust until the pipeline listener is ready", async () => {
    deferPipelineListenerRegistration = true;
    const r = render(<ImportModal onClose={() => {}} />);
    fireEvent.change(urlInput(), { target: { value: SAMPLE_URL } });
    fireEvent.click(r.getByRole("button", { name: "开始解析" }));

    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalledWith("import_video", expect.anything());

    await act(async () => resolveDeferredPipelineListener?.());
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("import_video", expect.anything()),
    );

    await act(async () => {
      pipelineHandler?.({
        payload: { stage: "Waiting", video_id: "vidReady", resource: "download" },
      });
    });
    expect(r.getByText("等待下载…")).toBeTruthy();
  });

  it("shows which scheduler resource the foreground import is waiting for", async () => {
    const r = await startImport();

    await act(async () => {
      pipelineHandler?.({
        payload: { stage: "Waiting", video_id: "vidWait", resource: "download" },
      });
    });
    expect(r.getByText("等待下载…")).toBeTruthy();

    await act(async () => {
      pipelineHandler?.({
        payload: { stage: "Waiting", video_id: "vidWait", resource: "compute" },
      });
    });
    expect(r.getByText("等待转录…")).toBeTruthy();
  });

  it("does not bind cancellation to an unrelated pre-start progress event", async () => {
    const r = await startImport();
    pipelineHandler?.({
      payload: { stage: "Downloading", video_id: "background-id", percent: 42 },
    });
    pipelineHandler?.({
      payload: { stage: "Started", video_id: "foreground-id", background: false },
    });
    await flush();

    fireEvent.click(r.getByTitle("取消下载 (Esc)"));
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("cancel_import", { videoId: "foreground-id" });
    expect(invokeMock).not.toHaveBeenCalledWith("cancel_import", { videoId: "background-id" });
  });

  it("keeps progress and cancellation visible while yt-dlp is retrying", async () => {
    const r = await startImport();
    pipelineHandler?.({
      payload: {
        stage: "Downloading",
        video_id: "vidRetry",
        percent: 87,
        speed: "1.2MiB/s",
        eta: "00:42",
      },
    });
    pipelineHandler?.({
      payload: {
        stage: "Retrying",
        video_id: "vidRetry",
        attempt: 2,
        delay_sec: 5,
        message: "网络波动，正在断点续传",
      },
    });
    await flush();

    expect(r.getByText("网络波动，正在断点续传")).toBeInTheDocument();
    expect(r.getByText(/87%/)).toBeInTheDocument();
    expect(r.queryByText(/1\.2MiB\/s/)).toBeNull();
    expect(r.queryByText(/00:42/)).toBeNull();
    expect(r.getByTitle("取消下载 (Esc)")).toBeInTheDocument();

    pipelineHandler?.({
      payload: {
        stage: "Downloading",
        video_id: "vidRetry",
        percent: 88,
        speed: "900KiB/s",
      },
    });
    await flush();

    expect(r.queryByText("网络波动，正在断点续传")).toBeNull();
    expect(r.getByText(/88%/)).toBeInTheDocument();
  });

  it("ignores interleaved background events after binding the foreground id", async () => {
    const r = await startImport();
    await act(async () => {
      pipelineHandler?.({
        payload: {
          stage: "Started",
          video_id: "foreground-id",
          source_kind: "url",
          source_value: SAMPLE_URL,
          background: false,
        },
      });
      pipelineHandler?.({
        payload: {
          stage: "Downloading",
          video_id: "foreground-id",
          percent: 42,
        },
      });
      pipelineHandler?.({
        payload: {
          stage: "Retrying",
          video_id: "background-id",
          attempt: 3,
          delay_sec: 10,
          message: "后台任务正在断点续传",
        },
      });
    });

    expect(r.getByText(/42%/)).toBeInTheDocument();
    expect(r.queryByText("后台任务正在断点续传")).toBeNull();

    fireEvent.click(r.getByTitle("取消下载 (Esc)"));
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("cancel_import", {
      videoId: "foreground-id",
    });
  });

  it("still cancels when Started did arrive", async () => {
    const r = await startImport();
    pipelineHandler?.({ payload: { stage: "Started", video_id: "vid999" } });
    await flush();

    fireEvent.click(r.getByTitle("取消下载 (Esc)"));
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("cancel_import", { videoId: "vid999" });
  });

  it("ignores a background Started event while waiting for the foreground one", async () => {
    const r = await startImport();
    pipelineHandler?.({
      payload: { stage: "Started", video_id: "background-id", background: true },
    });
    pipelineHandler?.({
      payload: { stage: "Started", video_id: "foreground-id", background: false },
    });
    await flush();

    fireEvent.click(r.getByTitle("取消下载 (Esc)"));
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("cancel_import", { videoId: "foreground-id" });
    expect(invokeMock).not.toHaveBeenCalledWith("cancel_import", { videoId: "background-id" });
  });

  it("does not close until the backend confirms process cleanup", async () => {
    deferImportCancel = true;
    const onClose = vi.fn();
    const r = await startImport(onClose);
    pipelineHandler?.({ payload: { stage: "Started", video_id: "vidWait" } });
    await flush();

    fireEvent.click(r.getByTitle("取消下载 (Esc)"));
    await flush();

    expect(onClose).not.toHaveBeenCalled();
    expect(r.getByText("正在停止并清理…")).toBeTruthy();

    await act(async () => resolveDeferredImportCancel?.());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps the progress window open when cancellation fails", async () => {
    rejectImportCancel = new Error("cancel timeout");
    const onClose = vi.fn();
    const r = await startImport(onClose);
    pipelineHandler?.({ payload: { stage: "Started", video_id: "vidFail" } });
    await flush();

    fireEvent.click(r.getByTitle("取消下载 (Esc)"));

    await waitFor(() => expect(r.getByText(/停止失败.*cancel timeout/)).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("waits for the first task id instead of closing an unknown running import", async () => {
    const onClose = vi.fn();
    const r = await startImport(onClose);

    fireEvent.click(r.getByTitle("取消下载 (Esc)"));
    await waitFor(() => expect(r.getByText("正在停止并清理…")).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("cancel_import", expect.anything());

    await act(async () => {
      pipelineHandler?.({
        payload: { stage: "Started", video_id: "vidLate", background: false },
      });
    });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("cancel_import", { videoId: "vidLate" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe("ImportModal — diagnosed download failures", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const loginButtonName = "\u91cd\u65b0\u767b\u5f55 YouTube";
  const cancelButtonName = "\u53d6\u6d88";
  const pendingLoginText = "\u7b49\u5f85 YouTube \u767b\u5f55\u5b8c\u6210";
  const diagnosisText = "YouTube \u8981\u6c42\u767b\u5f55\u9a8c\u8bc1";

  async function startImport(onClose: () => void = () => {}) {
    const r = render(<ImportModal onClose={onClose} />);
    fireEvent.change(urlInput(), { target: { value: SAMPLE_URL } });
    fireEvent.click(r.getByRole("button", { name: "开始解析" }));
    await flush();
    return r;
  }

  async function startPendingYouTubeLogin() {
    const r = await startImport();
    await act(async () => {
      pipelineHandler?.({
        payload: {
          stage: "Failed",
          video_id: "auth-video",
          error: "ERROR: Sign in to confirm you're not a bot. Use --cookies.",
        },
      });
    });
    fireEvent.click(await r.findByRole("button", { name: loginButtonName }));
    await waitFor(() => expect(r.getByText(pendingLoginText)).toBeInTheDocument());
    return r;
  }

  beforeEach(() => {
    invokeMock.mockClear();
    pipelineHandler = null;
    eventHandlers.clear();
  });

  it("shows the YouTube auth diagnosis without starting login", async () => {
    const r = await startImport();
    await act(async () => {
      pipelineHandler?.({
        payload: {
          stage: "Failed",
          video_id: "auth-video",
          error: "ERROR: [youtube] Sign in to confirm you’re not a bot. Use --cookies.",
        },
      });
    });

    await waitFor(() =>
      expect(r.getByText("YouTube 要求登录验证")).toBeInTheDocument(),
    );
    expect(r.getAllByText(/触发了反机器人检测/)).not.toHaveLength(0);
    expect(r.getByRole("button", { name: "重新登录 YouTube" })).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "site_login_start"),
    ).toHaveLength(0);
  });

  it("starts YouTube login only after the diagnosis action is clicked", async () => {
    const r = await startImport();
    await act(async () => {
      pipelineHandler?.({
        payload: {
          stage: "Failed",
          video_id: "auth-video",
          error: "The provided account cookies are no longer valid. Please refresh your cookies.",
        },
      });
    });

    fireEvent.click(await r.findByRole("button", { name: "重新登录 YouTube" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("site_login_start", {
        args: {
          key: "youtube",
          label: "YouTube",
          loginUrl: "https://www.youtube.com/",
          harvestDomains: ["youtube.com", "google.com", "googleusercontent.com"],
        },
      }),
    );
    expect(r.getByText("等待 YouTube 登录完成")).toBeInTheDocument();
  });

  it("retries the original import only once after login succeeds", async () => {
    const r = await startImport();
    await act(async () => {
      pipelineHandler?.({
        payload: {
          stage: "Failed",
          video_id: "auth-video",
          error: "The provided account cookies are no longer valid. Please refresh your cookies.",
        },
      });
    });
    fireEvent.click(await r.findByRole("button", { name: "重新登录 YouTube" }));
    await waitFor(() =>
      expect(r.getByText("等待 YouTube 登录完成")).toBeInTheDocument(),
    );

    await act(async () => {
      eventHandlers.get("site-login-success")?.({ payload: {} });
      eventHandlers.get("site-login-success")?.({ payload: {} });
    });

    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "import_video");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
    });
  });

  it("returns to the diagnosis without retrying when login is cancelled", async () => {
    const r = await startImport();
    await act(async () => {
      pipelineHandler?.({
        payload: {
          stage: "Failed",
          video_id: "auth-video",
          error: "ERROR: Sign in to confirm you're not a bot. Use --cookies.",
        },
      });
    });
    fireEvent.click(await r.findByRole("button", { name: "重新登录 YouTube" }));
    fireEvent.click(await r.findByRole("button", { name: "取消" }));

    await waitFor(() => expect(r.getByText("YouTube 要求登录验证")).toBeInTheDocument());
    expect(invokeMock).toHaveBeenCalledWith("site_login_cancel");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "import_video")).toHaveLength(1);
    expect(urlInput().value).toBe(SAMPLE_URL);
  });

  it("revokes authorized late login listeners after unmount", async () => {
    deferSiteLoginListenerRegistrations = true;
    const r = await startPendingYouTubeLogin();

    r.unmount();
    await act(async () => {
      resolveDeferredSiteLoginListeners();
      await Promise.resolve();
    });
    expect(lateSiteLoginUnlistenMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      eventHandlers.get("site-login-success")?.({ payload: {} });
    });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "import_video")).toHaveLength(1);
  });

  it("does not retry when success arrives while local cancellation is pending", async () => {
    const r = await startPendingYouTubeLogin();
    deferSiteLoginCancel = true;

    fireEvent.click(r.getByRole("button", { name: cancelButtonName }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("site_login_cancel"));

    await act(async () => {
      eventHandlers.get("site-login-success")?.({ payload: {} });
    });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "import_video")).toHaveLength(1);

    expect(resolveDeferredSiteLoginCancel).not.toBeNull();
    await act(async () => {
      resolveDeferredSiteLoginCancel?.();
    });
    await waitFor(() => expect(r.getByText(diagnosisText)).toBeInTheDocument());
  });

  it("ignores a site-login-cancelled event without an authorized login", async () => {
    await startImport();

    await act(async () => {
      eventHandlers.get("site-login-cancelled")?.({ payload: {} });
    });

    expect(document.querySelector('[data-tour="url-input"]')).toBeNull();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "import_video")).toHaveLength(1);
  });

  it("restores the diagnosis when site-login-cancelled arrives during login", async () => {
    const r = await startPendingYouTubeLogin();

    await act(async () => {
      eventHandlers.get("site-login-cancelled")?.({ payload: {} });
    });

    await waitFor(() => expect(r.getByText(diagnosisText)).toBeInTheDocument());
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "import_video")).toHaveLength(1);
    expect(urlInput().value).toBe(SAMPLE_URL);
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
