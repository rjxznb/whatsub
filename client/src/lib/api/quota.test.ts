import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { libraryQuota, corpusQuota } from "./quota";

// invoke is mocked globally in test-setup.ts; grab the mock to drive
// get_session_token. fetch is spied per-test.
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe("quota api", () => {
  beforeEach(() => mockInvoke.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("libraryQuota GETs /api/library/quota with a Bearer token and parses json", async () => {
    mockInvoke.mockResolvedValue("tok-123");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okJson({ used: 2, limit: 3 }));

    const q = await libraryQuota();

    expect(q).toEqual({ used: 2, limit: 3 });
    expect(mockInvoke).toHaveBeenCalledWith("get_session_token");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://whatsub.eversay.cc/api/library/quota");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("corpusQuota hits /api/corpus/quota", async () => {
    mockInvoke.mockResolvedValue("tok");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okJson({ used: 7, limit: 50 }));

    const q = await corpusQuota();

    expect(q).toEqual({ used: 7, limit: 50 });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://whatsub.eversay.cc/api/corpus/quota");
  });

  it("throws auth_required when there is no session token", async () => {
    mockInvoke.mockResolvedValue(null);
    await expect(libraryQuota()).rejects.toThrow("auth_required");
  });

  it("throws on a non-ok HTTP response", async () => {
    mockInvoke.mockResolvedValue("tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      { ok: false, status: 500, text: async () => "boom" } as unknown as Response,
    );
    await expect(corpusQuota()).rejects.toThrow(/quota http 500/);
  });
});
