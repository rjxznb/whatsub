import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import { AgentRoot, pageDefaultMode } from "./AgentRoot";
import { useAgent } from "../../store/agent";
import { useSettings } from "../../store/settings";
import { DEFAULT_SETTINGS } from "../../types/settings";
import * as nav from "../../agent/nav";

// AgentRoot pulls in:
//   - useAgent.hydrate() (Tauri invoke under the hood — already mocked globally
//     in test-setup.ts to return undefined; hydrate's catch block tolerates it).
//   - getProvider(settings) inside handleSend — we never click send in these
//     tests, so no need to mock individual provider modules.
//   - ConversationHeader uses @tauri-apps/plugin-dialog; mock it so dropdown
//     interactions don't blow up the test env.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(false),
  message: vi.fn().mockResolvedValue(undefined),
  ask: vi.fn().mockResolvedValue(false),
}));

// AgentRoot imports runtime / providers at module top. Tests neither click
// "send" nor mount streaming, but stubbing runTurn keeps any future test
// extension (that DOES click send) deterministic.
vi.mock("../../agent/runtime", () => ({
  runTurn: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  // Reset agent store between tests so message count + activeConversationId
  // are predictable.
  useAgent.setState({
    history: { version: 1, activeConversationId: null, conversations: [] },
    hydrated: true,
  });
  // Reset settings store. Default has no apiKey so noLlm=true; tests that need
  // a configured LLM set their own settings override.
  useSettings.setState({
    settings: DEFAULT_SETTINGS,
    loaded: true,
  });
  // Wipe persisted mode + position keys so each test starts fresh.
  try {
    localStorage.removeItem("agentBarMode");
    localStorage.removeItem("agentPanelOpen");
    localStorage.removeItem("agentIconPos");
    localStorage.removeItem("agentBarPos");
  } catch {
    /* ignore */
  }
});

function renderWithRouter(initialPath: string = "/library") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AgentRoot />
    </MemoryRouter>,
  );
}

describe("pageDefaultMode", () => {
  it("/player/* → icon", () => {
    expect(pageDefaultMode("/player/abc")).toBe("icon");
    expect(pageDefaultMode("/player/xyz?t=5")).toBe("icon");
  });

  it("everything else → bar", () => {
    expect(pageDefaultMode("/")).toBe("bar");
    expect(pageDefaultMode("/library")).toBe("bar");
    expect(pageDefaultMode("/settings")).toBe("bar");
    expect(pageDefaultMode("/corpus")).toBe("bar");
  });
});

describe("AgentRoot — initial mount", () => {
  it("mounts in bar mode on /library by default", () => {
    renderWithRouter("/library");
    // ChatBar in bar mode exposes the dialog role with aria-expanded=false.
    const dialog = screen.getByRole("dialog", { name: "AI 助手" });
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-expanded")).toBe("false");
  });

  it("mounts in icon mode on /player/X by default", () => {
    renderWithRouter("/player/abc");
    // In icon mode no dialog renders — instead the "打开 AI 助手" button is up.
    expect(
      screen.getByRole("button", { name: "打开 AI 助手" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "AI 助手" })).toBeNull();
  });

  it("persisted mode survives reload", () => {
    localStorage.setItem("agentBarMode", "panel");
    renderWithRouter("/library");
    const dialog = screen.getByRole("dialog", { name: "AI 助手" });
    expect(dialog.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not render the header content while in bar mode", () => {
    renderWithRouter("/library");
    // ConversationHeader's 选择会话 button only appears when expanded.
    expect(screen.queryByRole("button", { name: "选择会话" })).toBeNull();
  });

  it("clicking the bar expands it to panel and shows EmptyState (noLlm copy)", () => {
    renderWithRouter("/library");
    const dialog = screen.getByRole("dialog", { name: "AI 助手" });
    // Click semantics now use mousedown + mouseup (no drag).
    fireEvent.mouseDown(dialog, { clientX: 200, clientY: 600 });
    fireEvent.mouseUp(document, { clientX: 200, clientY: 600 });
    expect(dialog.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.textContent).toContain("需要先配置 LLM");
  });

  it("calls setNavigator on mount (so nav tools can route)", () => {
    const spy = vi.spyOn(nav, "setNavigator");
    renderWithRouter("/library");
    // Called at least once at mount; we don't assert exact arg because the
    // navigate fn identity is opaque, but it must NOT be null.
    expect(spy).toHaveBeenCalled();
    const firstCall = spy.mock.calls[0]?.[0];
    expect(firstCall).not.toBeNull();
    expect(typeof firstCall).toBe("function");
  });

  it("calls useAgent.hydrate() once on mount", () => {
    const hydrateSpy = vi.fn().mockResolvedValue(undefined);
    // Swap hydrate to a spy via setState. (zustand's create allows full slot
    // replacement; useAgent.getState() returns the live object after.)
    useAgent.setState({ hydrate: hydrateSpy });
    renderWithRouter("/library");
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
  });

  it("clears setNavigator on unmount", () => {
    const spy = vi.spyOn(nav, "setNavigator");
    const { unmount } = renderWithRouter("/library");
    spy.mockClear();
    unmount();
    // Cleanup pass should set the navigator to null.
    expect(spy).toHaveBeenCalledWith(null);
  });

  it("EmptyState is replaced by MessageList once messages exist", () => {
    // Seed a conversation with one user message + an assistant reply so
    // MessageList renders something (both bubbles are non-null).
    useAgent.setState({
      history: {
        version: 1,
        activeConversationId: "c1",
        conversations: [
          {
            id: "c1",
            title: "test",
            createdAt: 1,
            updatedAt: 2,
            pageContextAtStart: { pathname: "/library" },
            summaryUpToMsgId: null,
            summary: null,
            messages: [
              { role: "user", id: "u1", ts: 1, content: "hi" },
              {
                role: "assistant",
                id: "a1",
                ts: 2,
                blocks: [{ type: "text", text: "hello" }],
                stopReason: "end_turn",
                vendor: "deepseek",
                model: "deepseek-chat",
              },
            ],
          },
        ],
      },
      hydrated: true,
    });
    renderWithRouter("/library");
    const dialog = screen.getByRole("dialog", { name: "AI 助手" });
    fireEvent.mouseDown(dialog, { clientX: 200, clientY: 600 });
    fireEvent.mouseUp(document, { clientX: 200, clientY: 600 });
    // EmptyState noLlm copy must NOT be present once messages exist.
    expect(dialog.textContent).not.toContain("AI 助手需要先配置 LLM");
    // The user message content should appear.
    expect(dialog.textContent).toContain("hi");
  });
});

// A tiny in-tree helper for the nav-aware tests: a button that swaps the
// route. AgentRoot's useLocation() will see the new pathname on the next
// render and the navigation-nudge effect fires.
function NavTrigger({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button data-testid="nav-trigger" onClick={() => navigate(to)}>
      go
    </button>
  );
}

function renderWithNav(initialPath: string, navTo: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <AgentRoot />
              <NavTrigger to={navTo} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AgentRoot — navigation nudges", () => {
  it("navigating from /library to /player/X with mode=bar switches to icon", () => {
    renderWithNav("/library", "/player/abc");
    // Confirm we started in bar mode.
    expect(
      screen.getByRole("dialog", { name: "AI 助手" }).getAttribute("aria-expanded"),
    ).toBe("false");
    act(() => {
      fireEvent.click(screen.getByTestId("nav-trigger"));
    });
    // After navigation: page-default for /player/X is "icon" and the mode
    // change is an instant JSX swap (the reverse collapse animation was
    // removed because a stale timer could leave the bar stuck mounted).
    expect(
      screen.getByRole("button", { name: "打开 AI 助手" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "AI 助手" })).toBeNull();
  });

  it("panel mode is sticky across navigation (does NOT collapse on nav)", () => {
    // Seed: persisted panel + on /library.
    localStorage.setItem("agentBarMode", "panel");
    renderWithNav("/library", "/player/abc");
    const dialog = screen.getByRole("dialog", { name: "AI 助手" });
    expect(dialog.getAttribute("aria-expanded")).toBe("true");
    act(() => {
      fireEvent.click(screen.getByTestId("nav-trigger"));
    });
    // Panel remains open after navigating to /player/X.
    const stillDialog = screen.getByRole("dialog", { name: "AI 助手" });
    expect(stillDialog.getAttribute("aria-expanded")).toBe("true");
  });
});
