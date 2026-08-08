import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { releaseAsset, rewriteManifest } from './gitcode-manifest.mjs';

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
    'REQUESTED_TAG: ${{ inputs.tag }}',
    'GH_TOKEN: ${{ github.token }}',
    'fetch_release_detail',
    'find_attachment_id',
    '/releases/$encoded_tag/attach_files/$attachment_id',
    'gh release view "$tag"',
    'windows-x86_64',
    'darwin-aarch64',
    '%header{content-range}',
    'Content-Range:\\ bytes\\ 0-0/[1-9][0-9]*$',
    '--globoff',
    'https://gitcode.com/rjxznb/whatsub-release.git',
    'REQUESTED_TAG',
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const forbidden of [
    'RELEASES_REPO_TOKEN',
    "requested_tag='${{ inputs.tag }}'",
    'https://github.com/rjxznb/whatsub-release.git',
    '--header "PRIVATE-TOKEN: $GITCODE_TOKEN" \\\n+                --upload-file',
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
});
