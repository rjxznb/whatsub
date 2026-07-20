import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ exit: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ Command: { create: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { isReadOnlyFsError, blockedMessage } from "./useUpdater";

describe("isReadOnlyFsError", () => {
  it("matches the errno Tauri actually surfaced to the user", () => {
    // Verbatim from the macOS report: the install failed with this text.
    expect(isReadOnlyFsError("Read-only file system (os error 30)")).toBe(true);
  });

  it("matches either the errno or the English phrasing alone", () => {
    expect(isReadOnlyFsError("failed to persist: os error 30")).toBe(true);
    expect(isReadOnlyFsError("read-only file system")).toBe(true);
  });

  it("does not swallow unrelated failures", () => {
    expect(isReadOnlyFsError("network error: connection refused")).toBe(false);
    expect(isReadOnlyFsError("signature verification failed")).toBe(false);
    // os error 3 / 300 must not match the `30` test.
    expect(isReadOnlyFsError("os error 3")).toBe(false);
    expect(isReadOnlyFsError("os error 300")).toBe(false);
  });
});

describe("blockedMessage", () => {
  it("returns null when the bundle can be updated in place", () => {
    expect(blockedMessage({ path: "/Applications/whatsub.app", updatable: true })).toBeNull();
  });

  it("returns null when the location is unknown (fail open)", () => {
    expect(blockedMessage(null)).toBeNull();
  });

  it("tells a .dmg user to drag the app to Applications", () => {
    const m = blockedMessage({ path: "/Volumes/whatsub/whatsub.app", updatable: false, reason: "dmg" });
    expect(m).toMatch(/磁盘映像/);
    expect(m).toMatch(/应用程序/);
  });

  it("explains App Translocation in plain terms", () => {
    const m = blockedMessage({ path: "/private/.../AppTranslocation/x/d/whatsub.app", updatable: false, reason: "translocated" });
    expect(m).toMatch(/应用程序/);
    expect(m).toMatch(/重新打开/);
  });

  it("falls back to generic read-only guidance for an unknown reason", () => {
    const m = blockedMessage({ path: "/somewhere", updatable: false, reason: "something-new" });
    expect(m).toMatch(/只读位置/);
    expect(m).toMatch(/应用程序/);
  });

  it("never leaks a raw errno to the user", () => {
    for (const reason of ["dmg", "translocated", "unwritable", "???"]) {
      const m = blockedMessage({ path: "/x", updatable: false, reason }) ?? "";
      expect(m).not.toMatch(/os error/i);
    }
  });
});
