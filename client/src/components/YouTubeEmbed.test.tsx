import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { YouTubeEmbed, parseYouTubeUrl, watchUrlFor } from './YouTubeEmbed';

const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (u: string) => openUrl(u),
}));

describe('parseYouTubeUrl', () => {
  it('parses youtu.be/<id>?t=120', () => {
    expect(parseYouTubeUrl('https://youtu.be/Abc123?t=120')).toEqual({
      videoId: 'Abc123', startSec: 120,
    });
  });

  it('parses youtube.com/watch?v=<id>&t=30', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=Abc123&t=30')).toEqual({
      videoId: 'Abc123', startSec: 30,
    });
  });

  it('defaults startSec to 0 when no timestamp', () => {
    expect(parseYouTubeUrl('https://youtu.be/Abc123')?.startSec).toBe(0);
  });

  it('returns null on invalid URL', () => {
    expect(parseYouTubeUrl('not a url')).toBeNull();
  });
});

describe('YouTubeEmbed', () => {
  it('renders an iframe with the correct embed URL', () => {
    const { container } = render(<YouTubeEmbed videoId="Abc123" startSec={42} />);
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeDefined();
    expect(iframe?.src).toContain('youtube-nocookie.com/embed/Abc123');
    expect(iframe?.src).toContain('start=42');
  });

  it('forces captions on by default via cc_load_policy=1', () => {
    const { container } = render(<YouTubeEmbed videoId="Abc123" />);
    const iframe = container.querySelector('iframe');
    expect(iframe?.src).toContain('cc_load_policy=1');
  });
});

describe('watchUrlFor', () => {
  it('builds a plain watch URL when there is no timestamp', () => {
    expect(watchUrlFor('Abc123', 0)).toBe('https://www.youtube.com/watch?v=Abc123');
  });

  it('carries the start time over as &t=<n>s so the browser lands on the same spot', () => {
    expect(watchUrlFor('Abc123', 42)).toBe('https://www.youtube.com/watch?v=Abc123&t=42s');
  });

  it('floors fractional seconds (YouTube ignores decimals)', () => {
    expect(watchUrlFor('Abc123', 42.7)).toBe('https://www.youtube.com/watch?v=Abc123&t=42s');
  });
});

describe('YouTubeEmbed fallback bar', () => {
  it('always shows the blocked-playback hint + browser escape hatch', () => {
    render(<YouTubeEmbed videoId="Abc123" />);
    // Explains the most common cause (proxy node flagged) so a user hitting
    // WebView2's opaque "已阻止此内容" page knows what to actually do.
    expect(screen.getByText(/已阻止|换.*节点/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /在浏览器中打开/ })).toBeInTheDocument();
  });

  it('opens the watch URL (with the timestamp) in the system browser', () => {
    openUrl.mockClear();
    render(<YouTubeEmbed videoId="Abc123" startSec={90} />);
    fireEvent.click(screen.getByRole('button', { name: /在浏览器中打开/ }));
    expect(openUrl).toHaveBeenCalledWith('https://www.youtube.com/watch?v=Abc123&t=90s');
  });

  it('renders a BARE iframe when the caller supplies className (it owns layout)', () => {
    // YouTubeResults fills a 16:9 box with `absolute inset-0` — wrapping that in
    // a static div would break positioning, and the hint bar has no room there.
    const { container } = render(
      <YouTubeEmbed videoId="Abc123" className="absolute inset-0 h-full w-full" />,
    );
    expect(container.firstChild).toBe(container.querySelector('iframe'));
    expect(screen.queryByRole('button', { name: /在浏览器中打开/ })).toBeNull();
  });
});
