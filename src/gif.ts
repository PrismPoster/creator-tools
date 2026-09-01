/**
 * GIF89a encoding for /tools/video-to-gif.
 *
 * Written here rather than pulled from a package on purpose. Every free tool in
 * `lib/tools/` is pure and dependency-free, a GIF encoder is a well-specified
 * few hundred lines, and a new production dependency would have to clear the
 * blocking moderate audit for the rest of the application's lifetime to save
 * exactly this file.
 *
 * Two decisions worth stating, because both are visible in the output:
 *
 * - **One global colour table for the whole animation**, not a local table per
 *   frame. A palette that shifts frame to frame makes flat areas crawl, which
 *   reads as compression noise even when every individual frame is optimal.
 * - **The palette comes from median cut** (`lib/tools/palette.ts`, the colour
 *   extractor's own quantiser) rather than a second implementation. Frequency
 *   counting would return the background six times and lose the one saturated
 *   thing the clip is actually about.
 */

import { extractPalette, type Rgb } from './palette.js';

/** A GIF colour table holds at most 256 entries, and its size must be a power of two. */
export const GIF_MAX_COLORS = 256;

/**
 * The widget's ceilings, here rather than in the component so the page's copy
 * and its JSON-LD quote the same numbers the tool enforces.
 *
 * A GIF's cost is frames × pixels in both encode time and file size. Sixty
 * frames at 320px is a few megabytes and a second or two of work; the same clip
 * at 30fps and 720px is tens of megabytes and a frozen tab.
 */
export const GIF_MAX_FRAMES = 60;
export const GIF_MAX_SECONDS = 10;
export const GIF_WIDTH_CHOICES = [240, 320, 480] as const;
export const GIF_DEFAULT_WIDTH = 320;
export const GIF_FPS_CHOICES = [8, 10, 12, 15] as const;
export const GIF_DEFAULT_FPS = 10;

/** Hundredths of a second, which is the only delay unit the format has. */
export type Centiseconds = number;

export interface GifFrame {
  /** One palette index per pixel, row-major, `width * height` long. */
  readonly indices: Uint8Array;
  /** How long this frame is shown. */
  readonly delay: Centiseconds;
}

export interface GifImage {
  readonly width: number;
  readonly height: number;
  readonly palette: readonly Rgb[];
  readonly frames: readonly GifFrame[];
  /** 0 loops forever, which is what every social platform expects of a GIF. */
  readonly loopCount?: number;
}

/**
 * Smallest power of two that holds `count` entries, floored at 2.
 *
 * The format stores the table size as an exponent, so a 200-colour palette is
 * written into a 256-entry table with the tail unused rather than truncated.
 */
export function paletteSlots(count: number): number {
  let slots = 2;
  while (slots < count && slots < GIF_MAX_COLORS) slots *= 2;
  return slots;
}

/**
 * Build one palette for a whole animation from a sample of its pixels, and the
 * lookup that maps any colour to its nearest entry.
 *
 * The lookup memoises by packed RGB. A frame is hundreds of thousands of pixels
 * over a few thousand distinct colours, so the cache turns a linear scan per
 * pixel into a linear scan per colour.
 */
export function buildGlobalPalette(
  sample: readonly Rgb[],
  maxColors: number = GIF_MAX_COLORS,
): { palette: Rgb[]; indexOf: (colour: Rgb) => number } {
  const size = Math.max(2, Math.min(maxColors, GIF_MAX_COLORS));
  const swatches = extractPalette([...sample], size);
  const palette: Rgb[] = swatches.map(({ r, g, b }) => ({ r, g, b }));

  // extractPalette can return fewer boxes than asked for when the source has
  // fewer distinct colours than slots; a table still needs at least two entries.
  if (palette.length === 0) palette.push({ r: 0, g: 0, b: 0 });
  while (palette.length < 2) palette.push({ ...palette[0]! });

  const cache = new Map<number, number>();
  const indexOf = (colour: Rgb): number => {
    const key = (colour.r << 16) | (colour.g << 8) | colour.b;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const entry = palette[i]!;
      const dr = entry.r - colour.r;
      const dg = entry.g - colour.g;
      const db = entry.b - colour.b;
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    cache.set(key, best);
    return best;
  };

  return { palette, indexOf };
}

/** Map one frame's RGBA bytes onto palette indices. */
export function indexFrame(
  rgba: Uint8ClampedArray | Uint8Array,
  indexOf: (colour: Rgb) => number,
): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    out[p] = indexOf({ r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! });
  }
  return out;
}

/**
 * GIF's variable-width LZW, LSB-first, as the format specifies it.
 *
 * The dictionary is reset with a clear code when it fills at 4096 entries
 * rather than being allowed to overflow; a decoder that meets a code above the
 * current width has no way to recover, so this is not optional.
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  const bytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;

  const emit = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  let dictionary = new Map<number, number>();
  let nextCode = endCode + 1;

  emit(clearCode);

  if (indices.length === 0) {
    emit(endCode);
    if (bitCount > 0) bytes.push(bitBuffer & 0xff);
    return toSubBlocks(bytes);
  }

  // The empty case returned above, so index 0 exists.
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const next = indices[i]!;
    const key = (prefix << 8) | next;
    const known = dictionary.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }

    emit(prefix);
    dictionary.set(key, nextCode);
    nextCode += 1;

    if (nextCode === 4096) {
      emit(clearCode);
      dictionary = new Map();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    } else if (nextCode > 1 << codeSize) {
      codeSize += 1;
    }

    prefix = next;
  }

  emit(prefix);
  emit(endCode);
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);

  return toSubBlocks(bytes);
}

/** Wrap a byte stream in the format's ≤255-byte sub-blocks, zero-terminated. */
function toSubBlocks(bytes: readonly number[]): Uint8Array {
  const blockCount = Math.ceil(bytes.length / 255);
  const out = new Uint8Array(bytes.length + blockCount + 1);
  let read = 0;
  let write = 0;
  while (read < bytes.length) {
    const size = Math.min(255, bytes.length - read);
    out[write++] = size;
    for (let i = 0; i < size; i++) out[write++] = bytes[read++]!;
  }
  out[write] = 0;
  return out;
}

function writeString(out: number[], text: string): void {
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i));
}

function writeShort(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff);
}

/**
 * Assemble a complete GIF89a.
 *
 * Returns null rather than a corrupt file when the inputs cannot make one: a
 * zero-sized canvas, no frames, a palette that will not fit, or a frame whose
 * index count does not match the dimensions.
 */
export function encodeGif(image: GifImage): Uint8Array | null {
  const { width, height, palette, frames } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (frames.length === 0) return null;
  if (palette.length === 0 || palette.length > GIF_MAX_COLORS) return null;
  for (const frame of frames) {
    if (frame.indices.length !== width * height) return null;
  }

  const slots = paletteSlots(palette.length);
  // The exponent stored in the descriptor: table size is 2^(n+1).
  const tableExponent = Math.log2(slots) - 1;
  const minCodeSize = Math.max(2, Math.log2(slots));

  const out: number[] = [];

  writeString(out, 'GIF89a');
  writeShort(out, width);
  writeShort(out, height);
  // Global colour table present, 8-bit colour resolution, unsorted.
  out.push(0x80 | (7 << 4) | tableExponent);
  out.push(0); // background colour index
  out.push(0); // pixel aspect ratio: none declared

  for (let i = 0; i < slots; i++) {
    const entry = palette[i];
    if (entry) out.push(entry.r & 0xff, entry.g & 0xff, entry.b & 0xff);
    else out.push(0, 0, 0);
  }

  // NETSCAPE2.0 application extension — the only way to say "loop".
  const loopCount = image.loopCount ?? 0;
  out.push(0x21, 0xff, 11);
  writeString(out, 'NETSCAPE2.0');
  out.push(3, 1);
  writeShort(out, loopCount);
  out.push(0);

  for (const frame of frames) {
    // Graphic control extension: delay, and "leave the frame in place" disposal,
    // which is correct because every frame here is full-size and opaque.
    out.push(0x21, 0xf9, 4);
    out.push(0); // no transparency, disposal method 0
    writeShort(out, Math.max(0, Math.round(frame.delay)));
    out.push(0); // transparent colour index, unused
    out.push(0);

    out.push(0x2c);
    writeShort(out, 0);
    writeShort(out, 0);
    writeShort(out, width);
    writeShort(out, height);
    out.push(0); // no local colour table, not interlaced

    out.push(minCodeSize);
    const compressed = lzwEncode(frame.indices, minCodeSize);
    for (let i = 0; i < compressed.length; i++) out.push(compressed[i]!);
  }

  out.push(0x3b); // trailer

  return Uint8Array.from(out);
}

/**
 * The frame timestamps for a clip, in seconds from its start.
 *
 * Capped at `maxFrames` because the cost of a GIF is frames × pixels and both
 * the encode and the file grow linearly: a 30-second clip at 15fps is 450
 * frames and tens of megabytes, which is not a GIF anyone can post.
 */
export function frameTimes(
  durationSeconds: number,
  fps: number,
  maxFrames: number,
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  if (!Number.isFinite(fps) || fps <= 0) return [];

  const wanted = Math.floor(durationSeconds * fps);
  const count = Math.max(1, Math.min(wanted, maxFrames));
  const step = durationSeconds / count;
  const times: number[] = [];
  for (let i = 0; i < count; i++) times.push(i * step);
  return times;
}

/**
 * Frame delay in centiseconds for a frame rate.
 *
 * Floored at 2, because a delay of 0 or 1 is not "as fast as possible": most
 * browsers and every major platform clamp it to 10, so a GIF that asks for 100
 * fps plays at a tenth of the speed the author saw in the preview.
 */
export function delayForFps(fps: number): Centiseconds {
  if (!Number.isFinite(fps) || fps <= 0) return 10;
  return Math.max(2, Math.round(100 / fps));
}
