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
  // Wipe panelOpen flag so each test starts in the "closed" branch.
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
  it("always renders the ChatWidget button", () => {
    renderWithRouter();
    // Default = panel closed → button has aria-label "打开 AI 助手".
    const btn = screen.getByRole("button", { name: "打开 AI 助手" });
    expect(btn).toBeTruthy();
  });

  it("does not render the chat dialog while panelOpen=false", () => {
    renderWithRouter();
    expect(screen.queryByRole("dialog", { name: "AI 助手" })).toBeNull();
  });

  it("clicking the widget opens the panel and shows EmptyState", () => {
    renderWithRouter();
    const widget = screen.getByRole("button", { name: "打开 AI 助手" });
    fireEvent.click(widget);
    const dialog = screen.getByRole("dialog", { name: "AI 助手" });
    expect(dialog).toBeTruthy();
    // EmptyState's noLlm copy renders because DEFAULT_SETTINGS has no apiKey.
    expect(dialog.textContent).toContain("AI 助手需要先配置 LLM");
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
    fireEvent.click(screen.getByRole("button", { name: "打开 AI 助手" }));
    const dialog = screen.getByRole("dialog", { name: "AI 助手" });
    // EmptyState noLlm copy must NOT be present once messages exist.
    expect(dialog.textContent).not.toContain("AI 助手需要先配置 LLM");
    // The user message content should appear.
    expect(dialog.textContent).toContain("hi");
  });
});
