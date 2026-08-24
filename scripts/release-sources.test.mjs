import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("active updater and release configuration contains GitCode as the primary source", () => {
  const workflowDir = new URL("../.github/workflows/", import.meta.url);
  const workflowText = readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => readFileSync(join(fileURLToPath(workflowDir), name), "utf8"))
    .join("\n");
  const activeText = [
    workflowText,
    read("client/src-tauri/tauri.conf.json"),
    read("client/src-tauri/src/commands/yt_dlp.rs"),
  ].join("\n");

  assert.match(activeText, /gitcode/i);
});

test("app updater prefers GitCode and retains GitHub fallback", () => {
  const config = JSON.parse(read("client/src-tauri/tauri.conf.json"));
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://api.gitcode.com/api/v5/repos/rjxznb/whatsub-release/raw/latest.json?ref=main",
    "https://github.com/rjxznb/whatsub-releases/releases/latest/download/latest.json",
  ]);
});

test("desktop release workflow publishes GitHub and mirrors to GitCode", () => {
  const workflow = read(".github/workflows/release.yml");
  assert.doesNotMatch(workflow, /DOGECLOUD_ACCESS_KEY/);
  assert.doesNotMatch(workflow, /DOGECLOUD_SECRET_KEY/);
  assert.doesNotMatch(workflow, /DOGECLOUD_BUCKET/);
  assert.doesNotMatch(workflow, /DOGECLOUD_DOWNLOAD_DOMAIN/);
  assert.doesNotMatch(workflow, /dogecloud_fetch\.py/);
  assert.doesNotMatch(workflow, /dogecloud_upload\.py/);
  assert.match(workflow, /mirror-gitcode/);
  assert.match(workflow, /GITCODE_TOKEN/);
  assert.match(workflow, /!inputs\.dry_run/);
  assert.match(
    workflow,
    /needs\.build-windows\.result == 'success'\s*&&\s*needs\.build-macos\.result == 'success'/,
  );
  assert.doesNotMatch(workflow, /PREV_LATEST/);
});
