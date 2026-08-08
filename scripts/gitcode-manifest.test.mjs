import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { releaseAsset, rewriteManifest } from './gitcode-manifest.mjs';
import { allowsPrivateToken } from './gitcode-upload-policy.mjs';

const githubAsset = (tag, fileName) =>
  `https://github.com/rjxznb/whatsub-releases/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;

test('rewrites both updater platform URLs to GitCode and preserves manifest fields', () => {
  const manifest = {
    version: '0.1.108',
    notes: 'A release note',
    pub_date: '2026-08-08T00:00:00Z',
    platforms: {
      'windows-x86_64': {
        url: githubAsset('v0.1.108', 'whatsub_0.1.108_x64-setup.exe'),
        signature: 'windows-signature',
      },
      'darwin-aarch64': {
        url: githubAsset('v0.1.108', 'whatsub_0.1.108_aarch64.app.tar.gz'),
        signature: 'darwin-signature',
      },
    },
  };

  const rewritten = rewriteManifest(manifest, {
    owner: 'rjxznb',
    repo: 'whatsub-release',
  });

  assert.deepEqual(rewritten, {
    ...manifest,
    platforms: {
      'windows-x86_64': {
        url: 'https://gitcode.com/rjxznb/whatsub-release/releases/download/v0.1.108/whatsub_0.1.108_x64-setup.exe',
        signature: 'windows-signature',
      },
      'darwin-aarch64': {
        url: 'https://gitcode.com/rjxznb/whatsub-release/releases/download/v0.1.108/whatsub_0.1.108_aarch64.app.tar.gz',
        signature: 'darwin-signature',
      },
    },
  });
  assert.notStrictEqual(rewritten, manifest);
  assert.notStrictEqual(rewritten.platforms, manifest.platforms);
});

test('rewrites an asset carried over from an older tag using its own tag', () => {
  const manifest = {
    version: '0.1.108',
    platforms: {
      'windows-x86_64': {
        url: githubAsset('v0.1.107', 'whatsub_0.1.107_x64-setup.exe'),
        signature: 'old-signature',
      },
    },
  };

  assert.equal(
    rewriteManifest(manifest, { owner: 'rjxznb', repo: 'whatsub-release' }).platforms[
      'windows-x86_64'
    ].url,
    'https://gitcode.com/rjxznb/whatsub-release/releases/download/v0.1.107/whatsub_0.1.107_x64-setup.exe',
  );
});

test('releaseAsset decodes the final URL filename', () => {
  assert.deepEqual(
    releaseAsset(githubAsset('v0.1.108', 'whatsub installer.exe')),
    { tag: 'v0.1.108', fileName: 'whatsub installer.exe' },
  );
});

test('releaseAsset decodes slash-bearing release tags', () => {
  assert.deepEqual(
    releaseAsset(githubAsset('release/2026.08', 'whatsub installer.exe')),
    { tag: 'release/2026.08', fileName: 'whatsub installer.exe' },
  );
});

test('rejects malformed or non-GitHub release asset hosts', () => {
  for (const url of [
    'https://gitcode.com/rjxznb/whatsub-release/releases/download/v0.1.108/app.exe',
    'https://github.com:444/rjxznb/whatsub-releases/releases/download/v0.1.108/app.exe',
    'https://user:password@github.com/rjxznb/whatsub-releases/releases/download/v0.1.108/app.exe',
    'https://github.com/other/repo/releases/download/v0.1.108/app.exe',
    'https://github.com/rjxznb/whatsub-releases/releases/tag/v0.1.108',
    'https://github.com/rjxznb/whatsub-releases/releases/download/v0.1.108/',
  ]) {
    assert.throws(() => releaseAsset(url), /GitHub release asset URL/);
  }
});

test('preserves manifests with missing platforms without adding entries', () => {
  const manifest = { version: '0.1.108', notes: 'no platforms yet' };

  assert.deepEqual(
    rewriteManifest(manifest, { owner: 'rjxznb', repo: 'whatsub-release' }),
    manifest,
  );
});

test('release workflow publishes before mirroring GitCode and skips both in dry runs', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );

  const publishJob = workflow.match(/^  publish:\r?\n[\s\S]*?(?=^  mirror-gitcode:)/m)?.[0];
  assert.ok(publishJob, 'release workflow must define the publish job before the GitCode mirror');
  assert.match(
    publishJob,
    /^      tag: \$\{\{ steps\.publish-release\.outputs\.tag \}\}$/m,
    'publish must expose the output emitted by the publish-release step',
  );
  assert.match(
    publishJob,
    /^    if: \|\r?\n\s*!inputs\.dry_run\b/m,
    'publish itself must be skipped during dry runs',
  );
  assert.match(workflow, /id:\s*publish-release/);
  assert.match(workflow, /echo\s+"tag=v\$VERSION"\s*>>\s*"\$GITHUB_OUTPUT"/);
  assert.match(workflow, /mirror-gitcode:\s*\r?\n\s*needs:\s*publish/);
  assert.match(workflow, /if:\s*\$\{\{\s*!inputs\.dry_run\s*&&\s*needs\.publish\.result\s*==\s*'success'\s*\}\}/);
  assert.match(workflow, /uses:\s*\.\/\.github\/workflows\/mirror-gitcode\.yml/);
  assert.match(workflow, /tag:\s*\$\{\{\s*needs\.publish\.outputs\.tag\s*\}\}/);
  assert.match(workflow, /GITCODE_TOKEN:\s*\$\{\{\s*secrets\.GITCODE_TOKEN\s*\}\}/);
  assert.doesNotMatch(workflow, /Mirror to JiHu GitLab/);
  assert.doesNotMatch(workflow, /GITLAB_TOKEN/);
});

test('runtime updater endpoints prefer GitCode and retain the official GitHub fallback', async () => {
  const config = JSON.parse(
    await readFile(new URL('../client/src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  );
  const endpoints = config.plugins.updater.endpoints;

  assert.deepEqual(endpoints, [
    'https://gitcode.com/rjxznb/whatsub-release/raw/main/latest.json',
    'https://github.com/rjxznb/whatsub-releases/releases/latest/download/latest.json',
  ]);
  assert.equal(
    endpoints.some((endpoint) => endpoint.includes('jihulab.com')),
    false,
    'the runtime updater must not retain a JiHuLab endpoint',
  );
});

test('yt-dlp mirror workflow uses the GitCode release controller security contract', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/mirror-ytdlp.yml', import.meta.url),
    'utf8',
  );

  for (const required of [
    'timeout-minutes: 60',
    'GITCODE_TOKEN',
    "api_base='https://api.gitcode.com/api/v5'",
    "tag='yt-dlp'",
    'fetch_release_detail',
    'find_attachment_id',
    '/releases/$encoded_tag/attach_files/$attachment_id',
    'Range: bytes=0-0',
    '%header{content-range}',
    'Content-Range:\\ bytes\\ 0-0/[1-9][0-9]*$',
    '--globoff',
    "trap 'rm -rf \"$work_dir\"' EXIT",
    '--url-query "file_name=$asset_name"',
    '.url?',
    '.headers?',
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const forbidden of ['jihulab.com', 'GITLAB_TOKEN', 'curl -I', 'GITCODE_TOKEN=', 'body:""', '--url-query "name=$asset_name"']) {
    assert.doesNotMatch(workflow, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(workflow, /uses:\s*actions\/checkout@v4/);
  assert.match(workflow, /node scripts\/gitcode-upload-policy\.mjs "\$upload_url"/);
  assert.match(workflow, /if \[ "\$upload_policy" = allow-private-token \]; then/);
  assert.match(workflow, /upload_command=\(curl .*--max-redirs 0\)/);
});

test('upload policy permits a token only for the exact GitCode API hostname', () => {
  assert.equal(allowsPrivateToken('https://api.gitcode.com/uploads/asset'), true);
  assert.equal(allowsPrivateToken('https://cdn.example.net/presigned-upload'), false);
  assert.equal(allowsPrivateToken('https://api.gitcode.com.evil.example/upload'), false);
  assert.equal(allowsPrivateToken('https://api.gitcode.com./upload'), false);
});

test('upload policy rejects URLs that could carry credentials or use a non-HTTPS scheme', () => {
  for (const uploadUrl of [
    'https://token@api.gitcode.com/upload',
    'https://api.gitcode.com:secret@cdn.example.net/upload',
    'http://api.gitcode.com/upload',
    'not a URL',
  ]) {
    assert.throws(() => allowsPrivateToken(uploadUrl), /upload URL/i);
  }
});

test('GitCode mirror workflow keeps its required security and verification contract', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/mirror-gitcode.yml', import.meta.url),
    'utf8',
  );

  for (const required of [
    'workflow_call',
    'workflow_dispatch',
    'GITCODE_TOKEN',
    'Range: bytes=0-0',
    'scripts/gitcode-manifest.mjs',
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const forbidden of ['curl -I', 'jihulab.com', 'GITCODE_TOKEN=']) {
    assert.doesNotMatch(workflow, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('GitCode mirror workflow hardens the release-mirror controller boundaries', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/mirror-gitcode.yml', import.meta.url),
    'utf8',
  );

  for (const required of [
    'timeout-minutes: 120',
    'REQUESTED_TAG: ${{ inputs.tag }}',
    'GH_TOKEN: ${{ github.token }}',
    'fetch_release_detail',
    'find_attachment_id',
    '/releases/$encoded_tag/attach_files/$attachment_id',
    'gh release view "$tag"',
    '%header{content-range}',
    'Content-Range:\\ bytes\\ 0-0/[1-9][0-9]*$',
    '--globoff',
    'https://gitcode.com/rjxznb/whatsub-release.git',
    'REQUESTED_TAG',
    '--url-query "access_token=$GITCODE_TOKEN"',
    '--url-query "file_name=$asset_name"',
    '.url?',
    '.headers?',
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const forbidden of [
    'RELEASES_REPO_TOKEN',
    "requested_tag='${{ inputs.tag }}'",
    'https://github.com/rjxznb/whatsub-release.git',
    '--header "PRIVATE-TOKEN: $GITCODE_TOKEN" \\\n+                --upload-file',
    'PRIVATE-TOKEN:',
    'Authorization: Bearer',
    'body:""',
    '--url-query "name=$asset_name"',
  ]) {
    assert.doesNotMatch(workflow, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(
    workflow,
    /PRIVATE-TOKEN:\s*(?!\$GITCODE_TOKEN\b)[^\s'"\\]+/,
    'a literal GitCode token must never be committed',
  );
  assert.doesNotMatch(
    workflow,
    /\.attach_file_id\s*\/\/\s*\.id/,
    'only the documented attach_file_id may be used for an attachment delete',
  );

  const planner = await readFile(
    new URL('./gitcode-mirror-plan.mjs', import.meta.url),
    'utf8',
  );
  assert.match(planner, /windows-x86_64/);
  assert.match(planner, /darwin-aarch64/);
});

test('mirror plan includes every requested-release asset plus carried updater assets', async () => {
  const { buildMirrorPlan } = await import('./gitcode-mirror-plan.mjs');
  const requestedTag = 'v0.1.108';
  const plan = buildMirrorPlan({
    requestedTag,
    currentAssets: [
      { name: 'latest.json' },
      { name: 'whatsub_0.1.108_x64-setup.exe' },
      { name: 'whatsub_0.1.108_x64-setup.exe.sig' },
      { name: 'whatsub_0.1.108.dmg' },
      { name: 'whatsub_0.1.108_aarch64.app.tar.gz' },
      { name: 'whatsub_0.1.108_aarch64.app.tar.gz.sig' },
    ],
    manifest: {
      platforms: {
        'windows-x86_64': {
          url: githubAsset('v0.1.107', 'whatsub_0.1.107_x64-setup.exe'),
        },
        'darwin-aarch64': {
          url: githubAsset('v0.1.106', 'whatsub_0.1.106_aarch64.app.tar.gz'),
        },
      },
    },
  });

  assert.deepEqual(
    plan.map(({ tag, fileName, source }) => ({ tag, fileName, source })),
    [
      { tag: requestedTag, fileName: 'latest.json', source: 'rewritten-manifest' },
      { tag: requestedTag, fileName: 'whatsub_0.1.108_x64-setup.exe', source: 'current-download' },
      { tag: requestedTag, fileName: 'whatsub_0.1.108_x64-setup.exe.sig', source: 'current-download' },
      { tag: requestedTag, fileName: 'whatsub_0.1.108.dmg', source: 'current-download' },
      { tag: requestedTag, fileName: 'whatsub_0.1.108_aarch64.app.tar.gz', source: 'current-download' },
      { tag: requestedTag, fileName: 'whatsub_0.1.108_aarch64.app.tar.gz.sig', source: 'current-download' },
      { tag: 'v0.1.107', fileName: 'whatsub_0.1.107_x64-setup.exe', source: 'carried-updater' },
      { tag: 'v0.1.106', fileName: 'whatsub_0.1.106_aarch64.app.tar.gz', source: 'carried-updater' },
    ],
  );
  assert.equal(new Set(plan.map(({ tag, fileName }) => `${tag}\u0000${fileName}`)).size, plan.length);
});

test('mirror workflow promotes the requested release before mirroring a full asset plan', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/mirror-gitcode.yml', import.meta.url),
    'utf8',
  );

  for (const required of [
    'promote_requested_release',
    'api_request --request PATCH',
    'scripts/gitcode-mirror-plan.mjs',
    'rewritten-manifest',
    'current-download',
    'carried-updater',
    'promote_requested_release "$tag"',
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.ok(
    workflow.indexOf('promote_requested_release "$tag"') < workflow.indexOf('while IFS= read -r asset'),
    'requested release promotion must happen before any asset processing',
  );
});
