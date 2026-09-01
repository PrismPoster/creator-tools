import { describe, expect, it } from 'vitest';
import {
  GIF_MAX_COLORS,
  buildGlobalPalette,
  delayForFps,
  encodeGif,
  frameTimes,
  indexFrame,
  lzwEncode,
  paletteSlots,
} from '../src/gif.js';

/**
 * A GIF LZW decoder, written for the test only.
 *
 * The encoder is the thing under test, so asserting on its output bytes would
 * only restate the implementation. Decoding the stream back and comparing it to
 * the indices that went in is the assertion that actually means "a decoder can
 * read this" — which is the only property that matters about a file format.
 */
function lzwDecode(data: Uint8Array, minCodeSize: number): number[] {
  // Unwrap the ≤255-byte sub-blocks.
  const bytes: number[] = [];
  let read = 0;
  while (read < data.length) {
    const size = data[read++];
    if (!size) break;
    for (let i = 0; i < size; i++) bytes.push(data[read++]!);
  }

  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dictionary: number[][] = [];
  const resetDictionary = () => {
    dictionary = [];
    for (let i = 0; i < clearCode; i++) dictionary.push([i]);
    dictionary.push([], []); // placeholders for the clear and end codes
    codeSize = minCodeSize + 1;
  };
  resetDictionary();

  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let cursor = 0;
  let previous: number[] | null = null;

  const nextCode = (): number | null => {
    while (bitCount < codeSize) {
      if (cursor >= bytes.length) return null;
      bitBuffer |= bytes[cursor++]! << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  for (;;) {
    const code = nextCode();
    if (code === null || code === endCode) break;

    if (code === clearCode) {
      resetDictionary();
      previous = null;
      continue;
    }

    let entry: number[];
    if (code < dictionary.length && dictionary[code]!.length > 0) {
      entry = dictionary[code]!;
    } else if (previous) {
      entry = [...previous, previous[0]!];
    } else {
      throw new Error(`undecodable code ${code}`);
    }

    out.push(...entry);

    if (previous) {
      dictionary.push([...previous, entry[0]!]);
      if (dictionary.length === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }

  return out;
}

const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };
const RED = { r: 220, g: 20, b: 20 };

describe('paletteSlots', () => {
  it('rounds a table up to a power of two', () => {
    expect(paletteSlots(2)).toBe(2);
    expect(paletteSlots(3)).toBe(4);
    expect(paletteSlots(200)).toBe(256);
  });

  it('never returns fewer than two or more than the format allows', () => {
    expect(paletteSlots(0)).toBe(2);
    expect(paletteSlots(1)).toBe(2);
    expect(paletteSlots(9999)).toBe(GIF_MAX_COLORS);
  });
});

describe('lzwEncode round-trips through a decoder', () => {
  it('survives a run of identical indices, which is what compresses', () => {
    const indices = new Uint8Array(1000).fill(3);
    expect(lzwDecode(lzwEncode(indices, 8), 8)).toEqual([...indices]);
  });

  it('survives a pattern that fills the dictionary past a code-width bump', () => {
    const indices = new Uint8Array(5000);
    for (let i = 0; i < indices.length; i++) indices[i] = i % 251;
    expect(lzwDecode(lzwEncode(indices, 8), 8)).toEqual([...indices]);
  });

  it('survives noise long enough to force a dictionary reset', () => {
    // Deterministic pseudo-random: a fixed sequence, so a failure is repeatable.
    const indices = new Uint8Array(40_000);
    let seed = 12345;
    for (let i = 0; i < indices.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      indices[i] = seed % 256;
    }
    expect(lzwDecode(lzwEncode(indices, 8), 8)).toEqual([...indices]);
  });

  it('handles a single pixel', () => {
    expect(lzwDecode(lzwEncode(new Uint8Array([7]), 8), 8)).toEqual([7]);
  });

  it('handles a two-colour image at the minimum code size', () => {
    const indices = new Uint8Array([0, 1, 1, 0, 1, 0, 0, 1]);
    expect(lzwDecode(lzwEncode(indices, 2), 2)).toEqual([...indices]);
  });
});

describe('buildGlobalPalette', () => {
  it('maps a colour to the nearest entry it has', () => {
    const { palette, indexOf } = buildGlobalPalette([BLACK, WHITE, RED], 4);
    expect(palette.length).toBeGreaterThanOrEqual(2);
    const nearBlack = indexOf({ r: 4, g: 4, b: 4 });
    expect(palette[nearBlack]!.r).toBeLessThan(60);
  });

  it('always produces a usable table even from one flat colour', () => {
    const { palette } = buildGlobalPalette([BLACK, BLACK, BLACK], 8);
    expect(palette.length).toBeGreaterThanOrEqual(2);
  });

  it('never exceeds the format ceiling however many colours are asked for', () => {
    const sample = Array.from({ length: 900 }, (_, i) => ({
      r: i % 256,
      g: (i * 7) % 256,
      b: (i * 13) % 256,
    }));
    const { palette } = buildGlobalPalette(sample, 1000);
    expect(palette.length).toBeLessThanOrEqual(GIF_MAX_COLORS);
  });

  it('is memoised: the same colour resolves to the same index', () => {
    const { indexOf } = buildGlobalPalette([BLACK, WHITE, RED], 4);
    expect(indexOf(RED)).toBe(indexOf(RED));
  });
});

describe('indexFrame', () => {
  it('produces one index per pixel and ignores the alpha byte', () => {
    const { indexOf } = buildGlobalPalette([BLACK, WHITE], 2);
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 0]);
    const indices = indexFrame(rgba, indexOf);
    expect(indices.length).toBe(2);
    expect(indices[0]).not.toBe(indices[1]);
  });
});

describe('encodeGif', () => {
  const palette = [BLACK, WHITE];
  const frame = (fill: number, size: number) => ({
    indices: new Uint8Array(size).fill(fill),
    delay: 10,
  });

  it('writes a GIF89a header and a trailer', () => {
    const gif = encodeGif({ width: 2, height: 2, palette, frames: [frame(0, 4)] })!;
    expect(gif).not.toBeNull();
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe('GIF89a');
    expect(gif[gif.length - 1]).toBe(0x3b);
  });

  it('writes the dimensions little-endian in the screen descriptor', () => {
    const gif = encodeGif({ width: 300, height: 200, palette, frames: [frame(0, 60_000)] })!;
    expect(gif[6]! | (gif[7]! << 8)).toBe(300);
    expect(gif[8]! | (gif[9]! << 8)).toBe(200);
  });

  it('declares the NETSCAPE loop extension so it animates forever', () => {
    const gif = encodeGif({ width: 2, height: 2, palette, frames: [frame(0, 4)] })!;
    const text = String.fromCharCode(...gif);
    expect(text).toContain('NETSCAPE2.0');
  });

  it('writes one graphic control extension per frame', () => {
    const frames = [frame(0, 4), frame(1, 4), frame(0, 4)];
    const gif = encodeGif({ width: 2, height: 2, palette, frames })!;
    let count = 0;
    for (let i = 0; i < gif.length - 1; i++) {
      if (gif[i] === 0x21 && gif[i + 1] === 0xf9) count += 1;
    }
    expect(count).toBe(frames.length);
  });

  it('refuses inputs that would make a corrupt file rather than writing one', () => {
    expect(encodeGif({ width: 0, height: 2, palette, frames: [frame(0, 0)] })).toBeNull();
    expect(encodeGif({ width: 2, height: 2, palette, frames: [] })).toBeNull();
    expect(encodeGif({ width: 2, height: 2, palette: [], frames: [frame(0, 4)] })).toBeNull();
    // A frame whose index count disagrees with the declared size.
    expect(encodeGif({ width: 2, height: 2, palette, frames: [frame(0, 3)] })).toBeNull();
  });
});

describe('frameTimes', () => {
  it('spreads frames evenly across the clip, starting at zero', () => {
    const times = frameTimes(2, 5, 100);
    expect(times.length).toBe(10);
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBeLessThan(2);
  });

  it('caps at the frame ceiling, because cost is frames times pixels', () => {
    expect(frameTimes(60, 30, 60).length).toBe(60);
  });

  it('always yields at least one frame for a very short clip', () => {
    expect(frameTimes(0.05, 10, 60).length).toBe(1);
  });

  it('returns nothing for a clip with no duration', () => {
    expect(frameTimes(0, 10, 60)).toEqual([]);
    expect(frameTimes(Number.NaN, 10, 60)).toEqual([]);
  });
});

describe('delayForFps', () => {
  it('converts a frame rate to hundredths of a second', () => {
    expect(delayForFps(10)).toBe(10);
    expect(delayForFps(20)).toBe(5);
  });

  // A delay of 0 or 1 is clamped to 10 by browsers and platforms, so a GIF that
  // asks for 100fps plays at a tenth of the speed its author previewed.
  it('never asks for a delay platforms silently clamp', () => {
    expect(delayForFps(100)).toBeGreaterThanOrEqual(2);
    expect(delayForFps(1000)).toBeGreaterThanOrEqual(2);
  });

  it('falls back to a tenth of a second for a nonsense rate', () => {
    expect(delayForFps(0)).toBe(10);
    expect(delayForFps(Number.NaN)).toBe(10);
  });
});
