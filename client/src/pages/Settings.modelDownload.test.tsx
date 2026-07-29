import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Settings } from "./Settings";

// Regression coverage for the stuck whisper-model dropdown: start a download,
// leave Settings, come back — the dropdown must still be usable and the
// in-flight download must still be visible, even when the selected tier and
// the downloading tier have diverged.

const routerState = vi.hoisted(() => ({ search: "" }));
vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useSearchParams: () => [new URLSearchParams(routerState.search), vi.fn()],
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
// The global test-setup mock returns undefined; this page chains .then on it.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "whisper_model_status":
        return false;
      case "whisper_model_partial_size":
        return 0;
      case "site_presets":
      case "site_logins_list":
        return [];
      default:
        return null;
    }
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("0.1.100") }));
vi.mock("../store/appDialog", () => ({ notify: vi.fn(), confirmDialog: vi.fn() }));
vi.mock("../tutor/learnerProfile", () => ({ resetLearnerProfile: vi.fn() }));
vi.mock("../components/ManagedRelayQuotaPanel", () => ({ ManagedRelayQuotaPanel: () => null }));
vi.mock("../components/AccountLoginDialog", () => ({ AccountLoginDialog: () => null }));
vi.mock("../components/SiteIcon", () => ({ SiteIcon: () => null }));
vi.mock("../hooks/useUpdater", () => ({ useUpdater: () => ({ status: { kind: "idle" } }) }));
vi.mock("../store/license", () => ({ useLicense: () => ({ state: null }) }));
vi.mock("../store/auth", () => ({
  useAuth: () => ({ status: "anonymous", user: null, logout: vi.fn(), refresh: vi.fn() }),
}));

// The user's persisted selection is "tiny"; the tier actually downloading is
// "small" — the divergence that used to strand the dropdown.
vi.mock("../store/settings", async () => {
  const { DEFAULT_SETTINGS } = await vi.importActual<
    typeof import("../types/settings")
  >("../types/settings");
  const settings = { ...DEFAULT_SETTINGS, whisperModel: "tiny" };
  return { useSettings: () => ({ settings, load: vi.fn(), save: vi.fn() }) };
});

let downloadState = {
  phase: "downloading" as string,
  activeSize: "small" as string | null,
  pct: 42,
  start: vi.fn(),
  pause: vi.fn(),
};
vi.mock("../store/modelDownload", () => ({
  useModelDownload: () => downloadState,
}));

function modelSelect(): HTMLSelectElement {
  // The whisper tier picker is the select whose options carry tier names.
  const selects = Array.from(document.querySelectorAll("select"));
  return selects.find((s) => s.textContent?.includes("极速"))! as HTMLSelectElement;
}

describe("Settings — whisper model picker during a download", () => {
  beforeEach(() => {
    routerState.search = "";
    downloadState = {
      phase: "downloading",
      activeSize: "small",
      pct: 42,
      start: vi.fn(),
      pause: vi.fn(),
    };
  });

  it("keeps the tier dropdown usable while a download is in flight", () => {
    // The old code disabled the select on a GLOBAL "some download running"
    // flag, which stranded the user with a dead control after 返回 + 回到设置.
    render(<Settings />);
    expect(modelSelect().disabled).toBe(false);
  });

  it("shows progress for the DOWNLOADING tier even when another is selected", () => {
    // selected = 极速 (tiny), downloading = 标准 (small). The bar used to be
    // keyed to the selection, so it vanished and the user saw only a locked
    // dropdown with no explanation.
    render(<Settings />);
    expect(screen.getByText(/「标准」下载中 42%/)).toBeInTheDocument();
  });

  it("labels a paused download by its own tier too", () => {
    downloadState = { ...downloadState, phase: "paused" };
    render(<Settings />);
    expect(screen.getByText(/「标准」已暂停（42%）/)).toBeInTheDocument();
  });

  it("renders no progress bar when nothing is downloading", () => {
    downloadState = { ...downloadState, phase: "idle", activeSize: null };
    render(<Settings />);
    expect(screen.queryByText(/下载中|已暂停/)).toBeNull();
    expect(modelSelect().disabled).toBe(false);
  });

  it("highlights the translation provider section from the quota recovery link", async () => {
    routerState.search = "highlight=llm-provider";

    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByTestId("llm-provider-section")).toHaveClass(
        "ring-amber-400/70",
      );
    });
  });
});
