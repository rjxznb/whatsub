import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const GITHUB_ASSET_PATH =
  /^\/rjxznb\/whatsub-releases\/releases\/download\/([^/]+)\/([^/]+)$/;

export function releaseAsset(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('GitHub release asset URL is invalid');
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError('GitHub release asset URL is invalid');
  }

  const match = parsed.pathname.match(GITHUB_ASSET_PATH);
  if (!match) {
    throw new TypeError('GitHub release asset URL is invalid');
  }

  let tag;
  let fileName;
  try {
    tag = decodeURIComponent(match[1]);
    fileName = decodeURIComponent(match[2]);
  } catch {
    throw new TypeError('GitHub release asset URL is invalid');
  }

  if (!tag || !fileName || fileName.includes('/')) {
    throw new TypeError('GitHub release asset URL is invalid');
  }

  return { tag, fileName };
}

export function rewriteManifest(manifest, { owner, repo }) {
  const rewritten = structuredClone(manifest);

  if (!rewritten.platforms || typeof rewritten.platforms !== 'object') {
    return rewritten;
  }

  for (const platform of Object.values(rewritten.platforms)) {
    if (!platform || typeof platform !== 'object' || typeof platform.url !== 'string') {
      continue;
    }

    const { tag, fileName } = releaseAsset(platform.url);
    platform.url = `https://gitcode.com/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
  }

  return rewritten;
}

function printHelp() {
  console.log('Usage: node scripts/gitcode-manifest.mjs <input> <output>');
}

async function main(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    printHelp();
    return;
  }

  if (args.length !== 2) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const manifest = JSON.parse(await readFile(args[0], 'utf8'));
  const rewritten = rewriteManifest(manifest, {
    owner: 'rjxznb',
    repo: 'whatsub-release',
  });
  await writeFile(args[1], `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
