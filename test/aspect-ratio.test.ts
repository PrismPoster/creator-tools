import { describe, expect, it } from 'vitest';
import {
  alignToBlock,
  COMMON_RATIOS,
  coverOutside,
  cropToRatio,
  fitInside,
  formatRatio,
  gcd,
  heightForWidth,
  nearestCommonRatio,
  padToRatio,
  simplifyRatio,
} from '../src/aspect-ratio.js';

describe('gcd', () => {
  it('reduces a real frame', () => {
    expect(gcd(1920, 1080)).toBe(120);
  });

  it('returns 0 for the one pair with no common divisor', () => {
    expect(gcd(0, 0)).toBe(0);
  });
});

describe('simplifyRatio', () => {
  it('reduces 1920x1080 to 16:9', () => {
    expect(simplifyRatio({ width: 1920, height: 1080 })).toEqual({ w: 16, h: 9 });
  });

  it('reduces 1080x1920 to 9:16', () => {
    expect(simplifyRatio({ width: 1080, height: 1920 })).toEqual({ w: 9, h: 16 });
  });

  it('rejects a non-integer size', () => {
    expect(simplifyRatio({ width: 100.5, height: 50 })).toBeNull();
  });
});

describe('formatRatio', () => {
  it('prints integral ratios in colon form', () => {
    expect(formatRatio({ w: 16, h: 9 })).toBe('16:9');
  });

  it('prints cinema ratios against 1', () => {
    expect(formatRatio({ w: 2.39, h: 1 })).toBe('2.39:1');
  });
});

describe('fit and cover', () => {
  it('letterboxes 16:9 content into a 1:1 box', () => {
    expect(fitInside({ width: 1080, height: 1080 }, { w: 16, h: 9 })).toEqual({
      width: 1080,
      height: 608,
    });
  });

  it('covers a 1:1 box with 16:9 content', () => {
    expect(coverOutside({ width: 1080, height: 1080 }, { w: 16, h: 9 })).toEqual({
      width: 1920,
      height: 1080,
    });
  });
});

describe('cropToRatio', () => {
  it('centre-crops 16:9 to 9:16', () => {
    const plan = cropToRatio({ width: 1920, height: 1080 }, { w: 9, h: 16 });
    expect(plan?.result).toEqual({ width: 608, height: 1080 });
    // Symmetric within a pixel, and the remainder goes right.
    expect(plan?.removed.left).toBe(656);
    expect(plan?.removed.right).toBe(656);
    expect(plan?.removed.top).toBe(0);
  });

  it('reports how much of the frame survives', () => {
    const plan = cropToRatio({ width: 1920, height: 1080 }, { w: 9, h: 16 });
    expect(plan?.areaKept).toBeGreaterThan(0.31);
    expect(plan?.areaKept).toBeLessThan(0.32);
  });

  it('gives an odd remainder to the bottom/right, consistently', () => {
    const plan = cropToRatio({ width: 101, height: 100 }, { w: 1, h: 1 });
    expect(plan?.removed.left).toBe(0);
    expect(plan?.removed.right).toBe(1);
  });
});

describe('padToRatio', () => {
  it('pillarboxes 9:16 out to 16:9', () => {
    const plan = padToRatio({ width: 1080, height: 1920 }, { w: 16, h: 9 });
    expect(plan?.result).toEqual({ width: 3413, height: 1920 });
    expect(plan?.imageFraction).toBeLessThan(0.32);
  });

  it('adds nothing when the source already matches', () => {
    const plan = padToRatio({ width: 1920, height: 1080 }, { w: 16, h: 9 });
    expect(plan?.added).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(plan?.imageFraction).toBe(1);
  });
});

describe('alignToBlock', () => {
  it('makes odd dimensions even by default', () => {
    expect(alignToBlock({ width: 1081, height: 607 })).toEqual({
      width: 1082,
      height: 608,
    });
  });

  it('aligns to a macroblock grid on request', () => {
    // 1080 is not a multiple of 16 (67.5 blocks), so a macroblock-aligned
    // encode has to move it. This is the case people are surprised by.
    expect(alignToBlock({ width: 1080, height: 1920 }, 16)).toEqual({
      width: 1088,
      height: 1920,
    });
  });

  it('leaves an already-aligned size untouched', () => {
    expect(alignToBlock({ width: 1920, height: 1080 }, 8)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('never rounds a small size down to zero', () => {
    expect(alignToBlock({ width: 1, height: 1 }, 16)).toEqual({
      width: 16,
      height: 16,
    });
  });
});

describe('nearestCommonRatio', () => {
  it('recognises a standard frame', () => {
    expect(nearestCommonRatio({ width: 1920, height: 1080 })).toBe('landscape169');
  });

  it('recognises an anamorphic frame', () => {
    expect(nearestCommonRatio({ width: 2048, height: 858 })).toBe('anamorphic239');
  });

  it('returns null when nothing is close', () => {
    expect(nearestCommonRatio({ width: 1000, height: 173 })).toBeNull();
  });
});

describe('COMMON_RATIOS', () => {
  it('every named ratio round-trips through heightForWidth', () => {
    for (const ratio of Object.values(COMMON_RATIOS)) {
      const height = heightForWidth(1080, ratio);
      expect(height).not.toBeNull();
      expect(height as number).toBeGreaterThan(0);
    }
  });
});
