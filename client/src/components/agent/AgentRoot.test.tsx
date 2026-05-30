import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AgentRoot } from "./AgentRoot";
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
  // Wipe panelOpen flag so each test starts in the "collapsed" branch.
  try {
    localStorage.removeItem("agentPanelOpen");
  } catch {
    /* ignore */
  }
});

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={["/library"]}>
      <AgentRoot />
    </MemoryRouter>,
  );
}

describe("AgentRoot", () => {
  it("always renders the ChatBar in collapsed state", () => {
    renderWithRouter();
    // ChatBar is always mounted as a dialog with aria-label "AI 助手".
    // In the collapsed state aria-expanded should be "false".
    const dialog = screen.getByRole("dialog", { name: "AI 助手" });
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not render the header content while collapsed", () => {
    renderWithRouter();
    // ConversationHeader's 选择会话 button only appears when expanded.
    expect(screen.queryByRole("button", { name: "选择会话" })).toBeNull();
  });

  it("clicking the bar expands it and shows EmptyState (noLlm copy)", () => {
    renderWithRouter();
    const dialog = screen.getByRole("dialog", { name: "AI 助手" });
    fireEvent.click(dialog);
    // After expand: aria-expanded flips and the EmptyState noLlm copy renders.
    expect(dialog.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.textContent).toContain("需要先配置 LLM");
  });

  it("calls setNavigator on mount (so nav tools can route)", () => {
    const spy = vi.spyOn(nav, "setNavigator");
    renderWithRouter();
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
    renderWithRouter();
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
  });

  it("clears setNavigator on unmount", () => {
    const spy = vi.spyOn(nav, "setNavigator");
    const { unmount } = renderWithRouter();
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
    renderWithRouter();
    const dialog = screen.getByRole("dialog", { name: "AI 助手" });
    fireEvent.click(dialog);
    // EmptyState noLlm copy must NOT be present once messages exist.
    expect(dialog.textContent).not.toContain("AI 助手需要先配置 LLM");
    // The user message content should appear.
    expect(dialog.textContent).toContain("hi");
  });
});
