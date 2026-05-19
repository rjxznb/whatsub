import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { YouTubeEmbed, parseYouTubeUrl } from './YouTubeEmbed';

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
    expect(iframe?.src).toContain('youtube.com/embed/Abc123');
    expect(iframe?.src).toContain('start=42');
  });
});
