import { describe, expect, it } from 'vitest';
import {
  frameSize,
  getPlacement,
  PLACEMENTS,
  safeAreaBox,
  safeAreaPx,
  safeAreaSourceUrl,
} from '../src/social-sizes.js';

describe('PLACEMENTS', () => {
  it('every render target actually matches its own declared ratio', () => {
    // This is the assertion that keeps a hand-typed size from drifting away
    // from the ratio it claims to be.
    for (const placement of PLACEMENTS) {
      const size = frameSize(placement);
      expect(size, placement.id).not.toBeNull();
      const { width, height } = size as { width: number; height: number };
      const declared = placement.ratio.w / placement.ratio.h;
      expect(Math.abs(width / height - declared), placement.id).toBeLessThan(0.01);
    }
  });

  it('has no duplicate ids', () => {
    const ids = PLACEMENTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every quoted safe area names a first-party source', () => {
    for (const placement of PLACEMENTS) {
      if (placement.safeArea.kind === 'noOverlay') continue;
      expect(safeAreaSourceUrl(placement), placement.id).toMatch(/^https:\/\//);
    }
  });
});

describe('Meta vertical safe area', () => {
  it('is 14/35/6 percent, which on 1080x1920 is 269/672/65px', () => {
    const reels = getPlacement('instagram-reels');
    expect(reels).not.toBeNull();
    expect(frameSize(reels!)).toEqual({ width: 1080, height: 1920 });
    expect(safeAreaPx(reels!)).toEqual({
      top: 269,
      bottom: 672,
      left: 65,
      right: 65,
    });
  });

  it('leaves a usable box in the middle', () => {
    const reels = getPlacement('instagram-reels')!;
    expect(safeAreaBox(reels)).toEqual({ width: 950, height: 979 });
  });
});

describe('TikTok', () => {
  it('returns null rather than inventing a fixed inset', () => {
    // The whole point: a caller must handle "no published safe area" rather
    // than receive a made-up number that reads as authoritative.
    const tiktok = getPlacement('tiktok-video')!;
    expect(tiktok.safeArea.kind).toBe('unpublished');
    expect(safeAreaPx(tiktok)).toBeNull();
    expect(safeAreaBox(tiktok)).toBeNull();
  });

  it('still reports a frame size', () => {
    expect(frameSize(getPlacement('tiktok-video')!)).toEqual({
      width: 1080,
      height: 1920,
    });
  });
});

describe('region-published safe areas', () => {
  it('centres the YouTube banner safe region', () => {
    const banner = getPlacement('youtube-channel-banner')!;
    const inset = safeAreaPx(banner);
    expect(inset).not.toBeNull();
    expect(inset!.left).toBe(inset!.right);
    expect(safeAreaBox(banner)).toEqual({ width: 1546, height: 423 });
  });
});

describe('placements without chrome', () => {
  it('report zero inset, not null', () => {
    expect(safeAreaPx(getPlacement('instagram-feed-square')!)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });
});
