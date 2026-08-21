import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function cleanDomain(domain) {
  return domain.replace(/\/+$/, "");
}

function trustedAssetFilename(rawUrl, expectedTag) {
  const match = rawUrl.match(
    /^https:\/\/github\.com\/rjxznb\/whatsub-releases\/releases\/download\/([^/?#]+)\/([^/?#]+)$/,
  );
  if (!match || /%(?:2f|5c|2e)/i.test(rawUrl)) {
    throw new Error(`Not a trusted GitHub release asset URL: ${rawUrl}`);
  }
  const tag = decodeURIComponent(match[1]);
  const filename = decodeURIComponent(match[2]);
  if (tag !== expectedTag || !filename || filename === "." || filename === ".." || /[\\/]/.test(filename)) {
    throw new Error(`Not a trusted GitHub release asset URL: ${rawUrl}`);
  }
  return filename;
}

export function buildDogeManifest(source, downloadDomain, tag, buildId) {
  if (!source || typeof source !== "object" || !source.platforms) {
    throw new Error("Source updater manifest has no platforms object");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(buildId)) throw new Error("Invalid build id");
  const domain = cleanDomain(downloadDomain);
  const platforms = {};
  const assets = [];

  for (const [platform, entry] of Object.entries(source.platforms)) {
    if (!entry?.url || !entry?.signature) {
      throw new Error(`Updater platform ${platform} is missing url or signature`);
    }
    const filename = trustedAssetFilename(entry.url, tag);
    const key = `app/${tag}/${buildId}/${filename}`;
    assets.push({ platform, sourceUrl: entry.url, key });
    platforms[platform] = {
      ...entry,
      url: `${domain}/${key.split("/").map(encodeURIComponent).join("/")}`,
    };
  }

  if (assets.length === 0) throw new Error("Updater manifest has no assets");
  return { manifest: { ...source, platforms }, assets };
}

async function main() {
  const [sourcePath, manifestPath, assetsPath, domain, tag, buildId] = process.argv.slice(2);
  if (!sourcePath || !manifestPath || !assetsPath || !domain || !tag || !buildId) {
    throw new Error(
      "Usage: node dogecloud-manifest.mjs <source.json> <manifest.json> <assets.json> <download-domain> <tag> <build-id>",
    );
  }
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  const result = buildDogeManifest(source, domain, tag, buildId);
  await writeFile(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  await writeFile(assetsPath, `${JSON.stringify(result.assets, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
