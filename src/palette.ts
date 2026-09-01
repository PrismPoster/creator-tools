/**
 * Pure colour helpers for the /tools/color-palette-extractor widget.
 *
 * Kept out of the component so the quantisation and the contrast maths are
 * testable without a DOM: the widget only reads pixels off a canvas and hands
 * the array here.
 *
 * The palette is extracted by median cut rather than by naive frequency
 * counting. Frequency counting on a photograph returns six shades of the same
 * background, because the background is most of the pixels — which looks like a
 * palette and is useless as one.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Swatch extends Rgb {
  hex: string;
  /** Share of sampled pixels this box accounted for, 0-1. */
  weight: number;
}

/** How many swatches the widget offers. Five is the working size: enough for a
 *  palette with a ground, two mids and an accent, few enough to actually use. */
export const PALETTE_SIZES = [3, 5, 8] as const;
export type PaletteSize = (typeof PALETTE_SIZES)[number];
export const DEFAULT_PALETTE_SIZE: PaletteSize = 5;

export function toHex({ r, g, b }: Rgb): string {
  const part = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

/** Relative luminance, sRGB, per WCAG. Used for the readable-text decision and
 *  for sorting a palette from ground to highlight. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** Whether black or white text reads better on a swatch, and by how much. */
export function readableTextOn(colour: Rgb): { onColour: 'black' | 'white'; ratio: number } {
  const black = contrastRatio(colour, { r: 0, g: 0, b: 0 });
  const white = contrastRatio(colour, { r: 255, g: 255, b: 255 });
  return black >= white
    ? { onColour: 'black', ratio: black }
    : { onColour: 'white', ratio: white };
}

/** The channel with the widest spread in a box, and that spread — the axis
 *  worth splitting, and how much splitting it is worth. */
function widestChannel(pixels: Rgb[]): { channel: keyof Rgb; range: number } {
  let channel: keyof Rgb = 'r';
  let range = -1;
  for (const candidate of ['r', 'g', 'b'] as const) {
    let min = 255;
    let max = 0;
    for (const pixel of pixels) {
      const value = pixel[candidate];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const spread = max - min;
    if (spread > range) {
      range = spread;
      channel = candidate;
    }
  }
  return { channel, range };
}

function average(pixels: Rgb[]): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const pixel of pixels) {
    r += pixel.r;
    g += pixel.g;
    b += pixel.b;
  }
  const n = pixels.length;
  return { r: r / n, g: g / n, b: b / n };
}

/**
 * Median-cut quantisation, split at the widest gap rather than at the median
 * index.
 *
 * Repeatedly takes the box with the widest colour spread, sorts it along that
 * channel, and cuts where the largest jump between consecutive values is. Then
 * averages each box.
 *
 * `size` is a plain number rather than `PaletteSize`: the extractor widget
 * offers 3, 5 or 8, but the GIF encoder asks the same quantiser for a 256-entry
 * colour table, and the algorithm has never cared which it is asked for.
 *
 * Both choices matter, and both were wrong first. Selecting the box with the
 * most *pixels* keeps subdividing the background; selecting by spread goes
 * where the colour actually varies. And cutting at the median *index* dilutes a
 * small accent into whatever it is sorted next to — six bright pixels in two
 * hundred dark ones come back as a slightly-less-dark grey. Cutting at the
 * widest gap separates clusters instead of counts, which is what rescues the
 * one colour a designer actually wanted out of the photograph.
 */
export function extractPalette(pixels: Rgb[], size: number): Swatch[] {
  if (pixels.length === 0) return [];

  let boxes: Rgb[][] = [pixels];

  while (boxes.length < size) {
    // The box whose colour varies most is the one worth splitting.
    let index = -1;
    let widest = 0;
    let axis: keyof Rgb = 'r';
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const { channel, range } = widestChannel(box);
      if (range > widest) {
        widest = range;
        index = i;
        axis = channel;
      }
    });
    // Every remaining box is a single flat colour. Padding the result with
    // duplicates would be a palette that lies about the image.
    if (index === -1) break;

    // `index` came from a scan over `boxes`, so the box exists.
    const sorted = [...boxes[index]!].sort((a, b) => a[axis] - b[axis]);
    let cut = 1;
    let biggestGap = -1;
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = sorted[i]![axis] - sorted[i - 1]![axis];
      if (gap > biggestGap) {
        biggestGap = gap;
        cut = i;
      }
    }

    const left = sorted.slice(0, cut);
    const right = sorted.slice(cut);
    boxes = [...boxes.slice(0, index), left, right, ...boxes.slice(index + 1)];
  }

  const total = pixels.length;
  return boxes
    .map((box) => {
      const mean = average(box);
      return { ...mean, hex: toHex(mean), weight: box.length / total };
    })
    // Darkest first: a palette reads as ground → mids → highlight, which is the
    // order somebody actually uses it in.
    .sort((a, b) => relativeLuminance(a) - relativeLuminance(b));
}

/** The palette as a phrase that can be pasted into a generation prompt. Hexes
 *  are not reliably honoured by image models, so this names the colours as a
 *  palette instruction rather than pretending they are exact. */
export function palettePromptPhrase(swatches: Swatch[]): string {
  if (swatches.length === 0) return '';
  return `colour palette of ${swatches.map((s) => s.hex).join(', ')}`;
}
