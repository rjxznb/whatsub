import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { releaseAsset } from './gitcode-manifest.mjs';

const REQUIRED_PLATFORMS = ['windows-x86_64', 'darwin-aarch64'];

function addAsset(plan, asset) {
  const key = `${asset.tag}\u0000${asset.fileName}`;
  if (!plan.has(key)) {
    plan.set(key, asset);
  }
}

export function buildMirrorPlan({ manifest, requestedTag, currentAssets }) {
  if (!requestedTag || typeof requestedTag !== 'string') {
    throw new TypeError('requestedTag must be a non-empty string');
  }
  if (!Array.isArray(currentAssets)) {
    throw new TypeError('currentAssets must be an array');
  }

  for (const platformName of REQUIRED_PLATFORMS) {
    if (typeof manifest?.platforms?.[platformName]?.url !== 'string') {
      throw new TypeError(`latest.json must provide a string URL for ${platformName}`);
    }
  }

  const plan = new Map();
  let hasLatestManifest = false;
  for (const asset of currentAssets) {
    if (!asset || typeof asset.name !== 'string' || !asset.name) {
      throw new TypeError('GitHub Release assets must have non-empty string names');
    }

    const source = asset.name === 'latest.json' ? 'rewritten-manifest' : 'current-download';
    hasLatestManifest ||= source === 'rewritten-manifest';
    addAsset(plan, { tag: requestedTag, fileName: asset.name, source });
  }
  if (!hasLatestManifest) {
    throw new TypeError('GitHub Release must include latest.json');
  }

  for (const platform of Object.values(manifest.platforms ?? {})) {
    if (!platform || typeof platform.url !== 'string') {
      continue;
    }

    const { tag, fileName } = releaseAsset(platform.url);
    const key = `${tag}\u0000${fileName}`;
    if (tag === requestedTag) {
      if (!plan.has(key)) {
        throw new TypeError(`latest.json references missing requested Release asset ${fileName}`);
      }
      continue;
    }
    addAsset(plan, { tag, fileName, source: 'carried-updater', sourceUrl: platform.url });
  }

  return [...plan.values()];
}

async function main(args) {
  if (args.length !== 4) {
    console.error('Usage: node scripts/gitcode-mirror-plan.mjs <manifest> <release-assets> <tag> <output>');
    process.exitCode = 1;
    return;
  }

  const [manifestFile, releaseAssetsFile, requestedTag, outputFile] = args;
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const release = JSON.parse(await readFile(releaseAssetsFile, 'utf8'));
  const currentAssets = Array.isArray(release) ? release : release.assets;
  const plan = buildMirrorPlan({ manifest, requestedTag, currentAssets });
  await writeFile(outputFile, `${JSON.stringify(plan)}\n`, 'utf8');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
