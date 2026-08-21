import assert from "node:assert/strict";
import test from "node:test";

import { buildDogeManifest } from "./dogecloud-manifest.mjs";

test("rewrites updater assets to versioned DogeCloud URLs and preserves signatures", () => {
  const source = {
    version: "0.1.110",
    notes: "Fixes",
    pub_date: "2026-08-21T00:00:00Z",
    platforms: {
      "windows-x86_64": {
        signature: "win-signature",
        url: "https://github.com/rjxznb/whatsub-releases/releases/download/v0.1.110/whatsub_0.1.110_x64-setup.exe",
      },
      "darwin-aarch64": {
        signature: "mac-signature",
        url: "https://github.com/rjxznb/whatsub-releases/releases/download/v0.1.110/whatsub.app.tar.gz",
      },
    },
  };

  const { manifest, assets } = buildDogeManifest(
    source,
    "https://download.eversay.cc/",
    "v0.1.110",
    "run-123-1",
  );

  assert.deepEqual(manifest, {
    ...source,
    platforms: {
      "windows-x86_64": {
        signature: "win-signature",
        url: "https://download.eversay.cc/app/v0.1.110/run-123-1/whatsub_0.1.110_x64-setup.exe",
      },
      "darwin-aarch64": {
        signature: "mac-signature",
        url: "https://download.eversay.cc/app/v0.1.110/run-123-1/whatsub.app.tar.gz",
      },
    },
  });
  assert.deepEqual(assets, [
    {
      platform: "windows-x86_64",
      sourceUrl: source.platforms["windows-x86_64"].url,
      key: "app/v0.1.110/run-123-1/whatsub_0.1.110_x64-setup.exe",
    },
    {
      platform: "darwin-aarch64",
      sourceUrl: source.platforms["darwin-aarch64"].url,
      key: "app/v0.1.110/run-123-1/whatsub.app.tar.gz",
    },
  ]);
});

test("rejects updater asset URLs without a filename", () => {
  assert.throws(
    () =>
      buildDogeManifest(
        {
          version: "0.1.110",
          platforms: {
            "windows-x86_64": { signature: "sig", url: "https://example.com/" },
          },
        },
        "https://download.eversay.cc",
        "v0.1.110",
        "run-123-1",
      ),
    /trusted GitHub release asset/i,
  );
});

for (const maliciousUrl of [
  "file:///proc/self/environ",
  "http://github.com/rjxznb/whatsub-releases/releases/download/v0.1.110/a.exe",
  "https://example.com/rjxznb/whatsub-releases/releases/download/v0.1.110/a.exe",
  "https://github.com/rjxznb/whatsub-releases/releases/download/v0.1.109/a.exe",
  "https://github.com/rjxznb/whatsub-releases/releases/download/v0.1.110/a%2Fb.exe",
]) {
  test(`rejects untrusted updater source URL: ${maliciousUrl}`, () => {
    assert.throws(
      () =>
        buildDogeManifest(
          {
            version: "0.1.110",
            platforms: { "windows-x86_64": { signature: "sig", url: maliciousUrl } },
          },
          "https://download.eversay.cc",
          "v0.1.110",
          "run-123-1",
        ),
      /trusted GitHub release asset/i,
    );
  });
}
