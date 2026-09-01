import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PALETTE_SIZE,
  PALETTE_SIZES,
  contrastRatio,
  extractPalette,
  palettePromptPhrase,
  readableTextOn,
  relativeLuminance,
  toHex,
  type Rgb,
} from '../src/palette.js';

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

describe('toHex', () => {
  it('formats an uppercase six-digit hex', () => {
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
    expect(toHex({ r: 255, g: 255, b: 255 })).toBe('#FFFFFF');
    expect(toHex({ r: 18, g: 52, b: 86 })).toBe('#123456');
  });

  it('rounds and clamps rather than emitting a malformed hex', () => {
    // Averaging a box produces fractional channels; clamping guards a rounding
    // overshoot at the top of the range.
    expect(toHex({ r: 17.6, g: 51.4, b: 85.5 })).toBe('#123356');
    expect(toHex({ r: 300, g: -20, b: 128 })).toBe('#FF0080');
  });
});

describe('contrast', () => {
  it('gives black on white the maximum ratio', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5);
  });

  it('is symmetric', () => {
    const a = { r: 30, g: 120, b: 200 };
    expect(contrastRatio(a, WHITE)).toBeCloseTo(contrastRatio(WHITE, a), 10);
  });

  it('gives a colour against itself a ratio of one', () => {
    const a = { r: 88, g: 120, b: 44 };
    expect(contrastRatio(a, a)).toBeCloseTo(1, 10);
  });

  it('orders luminance from black to white', () => {
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
  });
});

describe('readableTextOn', () => {
  it('puts black text on a light swatch and white on a dark one', () => {
    expect(readableTextOn({ r: 240, g: 240, b: 230 }).onColour).toBe('black');
    expect(readableTextOn({ r: 20, g: 24, b: 40 }).onColour).toBe('white');
  });

  it('reports the ratio it chose, so the widget can show it', () => {
    const result = readableTextOn(WHITE);
    expect(result.onColour).toBe('black');
    expect(result.ratio).toBeCloseTo(21, 5);
  });
});

describe('extractPalette', () => {
  it('returns nothing for an empty image', () => {
    expect(extractPalette([], 5)).toEqual([]);
  });

  it('splits distinct colours into their own swatches', () => {
    const pixels: Rgb[] = [
      ...Array.from({ length: 40 }, () => ({ r: 250, g: 250, b: 250 })),
      ...Array.from({ length: 40 }, () => ({ r: 5, g: 5, b: 5 })),
      ...Array.from({ length: 40 }, () => ({ r: 200, g: 30, b: 30 })),
    ];
    const palette = extractPalette(pixels, 3);

    expect(palette).toHaveLength(3);
    const hexes = palette.map((s) => s.hex);
    expect(hexes).toContain('#FAFAFA');
    expect(hexes).toContain('#050505');
  });

  it('keeps a small bright accent instead of averaging it away', () => {
    // Frequency counting returns six shades of the background here. Splitting
    // the largest box by its widest channel is what rescues the accent.
    const pixels: Rgb[] = [
      ...Array.from({ length: 200 }, () => ({ r: 40, g: 42, b: 45 })),
      ...Array.from({ length: 6 }, () => ({ r: 255, g: 190, b: 0 })),
    ];
    const palette = extractPalette(pixels, 3);
    const brightest = palette[palette.length - 1]!;
    expect(brightest.r).toBeGreaterThan(180);
    expect(brightest.g).toBeGreaterThan(120);
  });

  it('orders swatches darkest first, so a palette reads ground to highlight', () => {
    const pixels: Rgb[] = [
      ...Array.from({ length: 30 }, () => ({ r: 250, g: 250, b: 250 })),
      ...Array.from({ length: 30 }, () => ({ r: 10, g: 10, b: 10 })),
      ...Array.from({ length: 30 }, () => ({ r: 128, g: 128, b: 128 })),
    ];
    const palette = extractPalette(pixels, 3);
    const luminances = palette.map(relativeLuminance);
    expect(luminances).toEqual([...luminances].sort((a, b) => a - b));
  });

  it('weights sum to one, so the shares are honest', () => {
    const pixels: Rgb[] = Array.from({ length: 64 }, (_, i) => ({ r: i * 4, g: 60, b: 200 - i }));
    const palette = extractPalette(pixels, 5);
    const total = palette.reduce((sum, s) => sum + s.weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('returns fewer swatches than asked rather than duplicating a flat image', () => {
    // A single flat colour cannot be split into five distinct boxes; padding the
    // result with copies would be a palette that lies about the image.
    const pixels: Rgb[] = Array.from({ length: 20 }, () => ({ r: 100, g: 100, b: 100 }));
    const palette = extractPalette(pixels, 8);
    expect(palette.length).toBeLessThanOrEqual(8);
    expect(palette.every((s) => s.hex === '#646464')).toBe(true);
  });
});

describe('palettePromptPhrase', () => {
  it('names the palette rather than pretending the hexes are exact', () => {
    const palette = extractPalette(
      [
        ...Array.from({ length: 10 }, () => ({ r: 0, g: 0, b: 0 })),
        ...Array.from({ length: 10 }, () => ({ r: 255, g: 255, b: 255 })),
      ],
      3,
    );
    const phrase = palettePromptPhrase(palette);
    expect(phrase.startsWith('colour palette of ')).toBe(true);
    expect(phrase).toContain('#000000');
  });

  it('is empty for an empty palette rather than a dangling phrase', () => {
    expect(palettePromptPhrase([])).toBe('');
  });
});

describe('the offered sizes', () => {
  it('includes the default', () => {
    expect(PALETTE_SIZES).toContain(DEFAULT_PALETTE_SIZE);
  });
});
