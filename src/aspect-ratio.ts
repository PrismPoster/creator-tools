/**
 * Aspect-ratio arithmetic for frames that are about to be encoded.
 *
 * Two conventions the rest of this module depends on:
 *
 * - A `Ratio` is a bare pair of positive numbers and is NOT required to be
 *   integral, because the ratios cinema uses are not. 2.39:1 and 1.85:1 are
 *   `{ w: 2.39, h: 1 }`, and the maths treats them exactly like 16:9.
 * - A `Size` is whole pixels. Every size returned here is something a person is
 *   about to type into an encoder or a crop box, so rounding to integers happens
 *   once, here, rather than separately at each call site.
 */

export interface Ratio {
  readonly w: number;
  readonly h: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface EdgeInset {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * Upper bound on a typed dimension. Well past any real frame (8K is 7,680 px)
 * while keeping percentage and area arithmetic inside comfortable float
 * precision.
 */
export const MAX_DIMENSION = 100_000;

/** Upper bound on one side of a custom ratio. */
export const MAX_RATIO_TERM = 10_000;

const isPositiveFinite = (n: number): boolean => Number.isFinite(n) && n > 0;

export function isValidRatio(ratio: Ratio): boolean {
  return (
    isPositiveFinite(ratio.w) &&
    isPositiveFinite(ratio.h) &&
    ratio.w <= MAX_RATIO_TERM &&
    ratio.h <= MAX_RATIO_TERM
  );
}

export function isValidSize(size: Size): boolean {
  return (
    Number.isInteger(size.width) &&
    Number.isInteger(size.height) &&
    size.width > 0 &&
    size.height > 0 &&
    size.width <= MAX_DIMENSION &&
    size.height <= MAX_DIMENSION
  );
}

/**
 * Greatest common divisor by Euclid's algorithm, on the magnitude of the
 * truncated inputs. `gcd(0, 0)` is 0 — the only pair with no common divisor —
 * so callers that divide by the result must reject zero sides first.
 */
export function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/** A pixel pair reduced to lowest terms: 1920x1080 becomes 16:9. */
export function simplifyRatio(size: Size): Ratio | null {
  if (!isValidSize(size)) return null;
  const divisor = gcd(size.width, size.height);
  if (divisor === 0) return null;
  return { w: size.width / divisor, h: size.height / divisor };
}

/** The decimal form: 16:9 is 1.777…. Returns null for an invalid ratio. */
export function ratioValue(ratio: Ratio): number | null {
  if (!isValidRatio(ratio)) return null;
  return ratio.w / ratio.h;
}

/**
 * Format a ratio for display. Integral ratios print as `16:9`; non-integral
 * cinema ratios print in their conventional decimal form, `2.39:1`.
 */
export function formatRatio(ratio: Ratio): string | null {
  if (!isValidRatio(ratio)) return null;
  if (Number.isInteger(ratio.w) && Number.isInteger(ratio.h)) {
    const divisor = gcd(ratio.w, ratio.h) || 1;
    return `${ratio.w / divisor}:${ratio.h / divisor}`;
  }
  const value = ratio.w / ratio.h;
  return `${Math.round(value * 100) / 100}:1`;
}

/** The height that pairs with `width` at `ratio`, rounded to whole pixels. */
export function heightForWidth(width: number, ratio: Ratio): number | null {
  if (!isValidRatio(ratio) || !isPositiveFinite(width)) return null;
  const height = Math.round((width * ratio.h) / ratio.w);
  return height > 0 ? height : null;
}

/** The width that pairs with `height` at `ratio`, rounded to whole pixels. */
export function widthForHeight(height: number, ratio: Ratio): number | null {
  if (!isValidRatio(ratio) || !isPositiveFinite(height)) return null;
  const width = Math.round((height * ratio.w) / ratio.h);
  return width > 0 ? width : null;
}

/**
 * Largest size at `ratio` that fits inside `bounds` — the letterbox/contain fit.
 * Nothing is cropped; the unused axis is left over.
 */
export function fitInside(bounds: Size, ratio: Ratio): Size | null {
  if (!isValidSize(bounds) || !isValidRatio(ratio)) return null;
  const target = ratio.w / ratio.h;
  const boundsRatio = bounds.width / bounds.height;
  const size =
    boundsRatio > target
      ? { width: Math.round(bounds.height * target), height: bounds.height }
      : { width: bounds.width, height: Math.round(bounds.width / target) };
  return isValidSize(size) ? size : null;
}

/**
 * Smallest size at `ratio` that covers `bounds` — the cover/fill fit. The
 * overflowing axis is what a later crop removes.
 */
export function coverOutside(bounds: Size, ratio: Ratio): Size | null {
  if (!isValidSize(bounds) || !isValidRatio(ratio)) return null;
  const target = ratio.w / ratio.h;
  const boundsRatio = bounds.width / bounds.height;
  const size =
    boundsRatio > target
      ? { width: bounds.width, height: Math.round(bounds.width / target) }
      : { width: Math.round(bounds.height * target), height: bounds.height };
  return isValidSize(size) ? size : null;
}

export interface CropPlan {
  /** The frame left after cropping. */
  readonly result: Size;
  /** Pixels removed from each edge. Opposite edges differ by at most 1px. */
  readonly removed: EdgeInset;
  /** Fraction of the original area kept, 0-1, rounded to 4 places. */
  readonly areaKept: number;
}

/**
 * Centre-crop `source` to `ratio`.
 *
 * An odd remainder cannot be split evenly, so the extra pixel goes to the
 * bottom/right edge. That is arbitrary but it must be *consistent*: splitting it
 * differently per call is how a batch of clips ends up 1px out of register with
 * each other.
 */
export function cropToRatio(source: Size, ratio: Ratio): CropPlan | null {
  if (!isValidSize(source) || !isValidRatio(ratio)) return null;
  const result = fitInside(source, ratio);
  if (!result) return null;

  const extraX = source.width - result.width;
  const extraY = source.height - result.height;
  const left = Math.floor(extraX / 2);
  const top = Math.floor(extraY / 2);

  const sourceArea = source.width * source.height;
  const areaKept =
    Math.round(((result.width * result.height) / sourceArea) * 10_000) / 10_000;

  return {
    result,
    removed: { top, right: extraX - left, bottom: extraY - top, left },
    areaKept,
  };
}

export interface PadPlan {
  /** The frame after padding. */
  readonly result: Size;
  /** Pixels added to each edge. Opposite edges differ by at most 1px. */
  readonly added: EdgeInset;
  /** Fraction of the padded frame that is original image, 0-1, 4 places. */
  readonly imageFraction: number;
}

/** Centre-pad (letterbox or pillarbox) `source` out to `ratio`. */
export function padToRatio(source: Size, ratio: Ratio): PadPlan | null {
  if (!isValidSize(source) || !isValidRatio(ratio)) return null;
  const result = coverOutside(source, ratio);
  if (!result) return null;

  const extraX = result.width - source.width;
  const extraY = result.height - source.height;
  const left = Math.floor(extraX / 2);
  const top = Math.floor(extraY / 2);

  const imageFraction =
    Math.round(
      ((source.width * source.height) / (result.width * result.height)) * 10_000,
    ) / 10_000;

  return {
    result,
    added: { top, right: extraX - left, bottom: extraY - top, left },
    imageFraction,
  };
}

/**
 * Round a size to a multiple of `block` on both axes, keeping it as close to the
 * requested ratio as the block grid allows.
 *
 * Most codecs want even dimensions; H.264 chroma subsampling makes an odd width
 * or height either an encoder error or a silent rescale. `block` defaults to 2
 * for that reason. Macroblock-aligned encodes use 16.
 */
export function alignToBlock(size: Size, block = 2): Size | null {
  if (!isValidSize(size)) return null;
  if (!Number.isInteger(block) || block < 1) return null;
  const width = Math.max(block, Math.round(size.width / block) * block);
  const height = Math.max(block, Math.round(size.height / block) * block);
  return isValidSize({ width, height }) ? { width, height } : null;
}

/** Named ratios that come up often enough to be worth not retyping. */
export const COMMON_RATIOS = {
  square: { w: 1, h: 1 },
  portrait45: { w: 4, h: 5 },
  vertical916: { w: 9, h: 16 },
  landscape169: { w: 16, h: 9 },
  classic43: { w: 4, h: 3 },
  widescreen185: { w: 1.85, h: 1 },
  anamorphic239: { w: 2.39, h: 1 },
  ultrawide219: { w: 21, h: 9 },
} as const satisfies Record<string, Ratio>;

export type CommonRatioId = keyof typeof COMMON_RATIOS;

/**
 * Closest named ratio to a given size, or null if nothing is within
 * `tolerance` (a fraction of the decimal ratio value, default 1%).
 */
export function nearestCommonRatio(
  size: Size,
  tolerance = 0.01,
): CommonRatioId | null {
  if (!isValidSize(size)) return null;
  const value = size.width / size.height;
  let best: CommonRatioId | null = null;
  let bestDelta = Infinity;
  for (const id of Object.keys(COMMON_RATIOS) as CommonRatioId[]) {
    const candidate = COMMON_RATIOS[id];
    const delta = Math.abs(candidate.w / candidate.h - value) / value;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = id;
    }
  }
  return bestDelta <= tolerance ? best : null;
}
