import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { downloadRoutes, latestRoute, _resetCache } from '../src/routes/download.js';

const FAKE_LATEST_JSON = {
  version: '0.1.99',
  pub_date: '2026-05-09T00:00:00Z',
  platforms: {
    'windows-x86_64': { url: 'https://jihulab.com/.../whatsub_x64-setup.exe', signature: 'sig' },
    'darwin-aarch64': { url: 'https://jihulab.com/.../whatsub_aarch64.dmg',   signature: 'sig' },
  },
};

beforeEach(() => {
  _resetCache();
  vi.spyOn(global, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify(FAKE_LATEST_JSON), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

function makeApp() {
  const app = new Hono();
  app.route('/download', downloadRoutes());
  app.route('/api', latestRoute());
  return app;
}

describe('GET /download/win', () => {
  it('redirects 302 to the latest Windows .exe URL', async () => {
    const res = await makeApp().request('/download/win');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://jihulab.com/.../whatsub_x64-setup.exe',
    );
  });

  it('falls back to GitHub mirror when upstream fetch throws', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('net'));
    _resetCache();
    const res = await makeApp().request('/download/win');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/github.com\/rjxznb\/whatsub-releases/);
  });
});

describe('GET /download/mac', () => {
  it('redirects 302 to the latest Mac .dmg URL', async () => {
    const res = await makeApp().request('/download/mac');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://jihulab.com/.../whatsub_aarch64.dmg',
    );
  });
});

describe('GET /api/latest', () => {
  it('returns the wrapped JSON for the website', async () => {
    const res = await makeApp().request('/api/latest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; winUrl: string; macUrl: string };
    expect(body.version).toBe('0.1.99');
    expect(body.winUrl).toContain('whatsub_x64-setup.exe');
    expect(body.macUrl).toContain('whatsub_aarch64.dmg');
  });

  it('returns 503 when upstream is unreachable', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('net'));
    _resetCache();
    const res = await makeApp().request('/api/latest');
    expect(res.status).toBe(503);
  });
});

describe('caching', () => {
  it('does NOT re-fetch within the cache window', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const app = makeApp();
    await app.request('/api/latest');
    await app.request('/api/latest');
    await app.request('/download/win');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
