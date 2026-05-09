import { Hono } from 'hono';

const LATEST_JSON_URL =
  'https://jihulab.com/rjxznb-group/whatsub-release/-/releases/permalink/latest/downloads/latest.json';
const GITHUB_FALLBACK_BASE =
  'https://github.com/rjxznb/whatsub-releases/releases/latest/download';

interface LatestJson {
  version: string;
  pub_date?: string;
  platforms: Record<string, { url: string; signature?: string }>;
}

let cached: { data: LatestJson; expiresAt: number } | null = null;

/** Test hook — reset the in-process cache between cases. */
export function _resetCache() {
  cached = null;
}

async function fetchLatest(): Promise<LatestJson> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.data;
  const res = await fetch(LATEST_JSON_URL, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`latest.json fetch failed: ${res.status}`);
  const data = (await res.json()) as LatestJson;
  cached = { data, expiresAt: now + 60_000 };
  return data;
}

export function downloadRoutes() {
  const app = new Hono();

  app.get('/win', async (c) => {
    try {
      const latest = await fetchLatest();
      return c.redirect(latest.platforms['windows-x86_64']!.url, 302);
    } catch {
      return c.redirect(`${GITHUB_FALLBACK_BASE}/whatsub_x64-setup.exe`, 302);
    }
  });

  app.get('/mac', async (c) => {
    try {
      const latest = await fetchLatest();
      return c.redirect(latest.platforms['darwin-aarch64']!.url, 302);
    } catch {
      return c.redirect(`${GITHUB_FALLBACK_BASE}/whatsub_aarch64.dmg`, 302);
    }
  });

  return app;
}

export function latestRoute() {
  const app = new Hono();

  app.get('/latest', async (c) => {
    try {
      const latest = await fetchLatest();
      return c.json({
        version: latest.version,
        pubDate: latest.pub_date ?? null,
        winUrl: latest.platforms['windows-x86_64']?.url ?? null,
        macUrl: latest.platforms['darwin-aarch64']?.url ?? null,
      });
    } catch {
      return c.json({ version: null, error: 'upstream_unavailable' }, 503);
    }
  });

  return app;
}
