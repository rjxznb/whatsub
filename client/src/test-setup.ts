import { vi } from "vitest";
import "@testing-library/jest-dom/vitest";

// Mock @tauri-apps/api/core — not available in the test (happy-dom) environment.
// convertFileSrc is used by FolderCard to build asset:// URLs for thumbnails;
// in tests we just return the path as-is so img.src is predictable.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

// Mock @tauri-apps/api/window — VideoPlayer's PiP teardown effect calls
// getCurrentWindow().onCloseRequested(...). In tests there's no Tauri
// runtime; return a stub whose onCloseRequested resolves to a no-op
// unlistener so the effect runs without throwing.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
  }),
}));
