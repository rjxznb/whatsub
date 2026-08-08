import { fileURLToPath } from 'node:url';

function parseUploadUrl(uploadUrl) {
  if (typeof uploadUrl !== 'string') {
    throw new TypeError('upload URL must be a valid HTTPS URL');
  }

  let parsed;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    throw new TypeError('upload URL must be a valid HTTPS URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new TypeError('upload URL must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('upload URL must not contain credentials');
  }

  return parsed;
}

export function allowsPrivateToken(uploadUrl) {
  return parseUploadUrl(uploadUrl).hostname === 'api.gitcode.com';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [uploadUrl] = process.argv.slice(2);
    process.stdout.write(allowsPrivateToken(uploadUrl) ? 'allow-private-token\n' : 'forbid-private-token\n');
  } catch {
    console.error('::error::GitCode returned an invalid upload URL');
    process.exitCode = 1;
  }
}
