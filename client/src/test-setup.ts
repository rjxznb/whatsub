import { vi } from "vitest";

// Mock @tauri-apps/api/core — not available in the test (happy-dom) environment.
// convertFileSrc is used by FolderCard to build asset:// URLs for thumbnails;
// in tests we just return the path as-is so img.src is predictable.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));
