import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

const invoke = vi.fn();
const listeners: Record<string, (e: { payload: unknown }) => void> = {};
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners[name] = cb;
    return Promise.resolve(() => delete listeners[name]);
  },
}));

import { useSiteLogin } from "./useSiteLogin";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "site_presets") return Promise.resolve([]);
    if (cmd === "site_login_browsers") return Promise.resolve(["chrome"]);
    if (cmd === "site_login_pending") return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
});

describe("useSiteLogin", () => {
  it("startLogin invokes site_login_start and sets pendingLogin", async () => {
    const { result } = renderHook(() => useSiteLogin());
    await act(async () => {
      await result.current.startLogin({
        key: "youtube", label: "YouTube",
        loginUrl: "https://youtube.com/", harvestDomains: ["youtube.com"],
      });
    });
    expect(invoke).toHaveBeenCalledWith("site_login_start", {
      args: { key: "youtube", label: "YouTube", loginUrl: "https://youtube.com/", harvestDomains: ["youtube.com"], browser: undefined },
    });
    expect(result.current.pendingLogin).toEqual({ key: "youtube", label: "YouTube" });
  });

  it("success event clears pending and calls onSuccess", async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useSiteLogin({ onSuccess }));
    await act(async () => {
      await result.current.startLogin({ key: "youtube", label: "YouTube", loginUrl: "u", harvestDomains: [] });
    });
    await act(async () => { listeners["site-login-success"]?.({ payload: null }); });
    await waitFor(() => expect(result.current.pendingLogin).toBeNull());
    expect(onSuccess).toHaveBeenCalled();
  });
});
