import { describe, expect, it } from 'vitest';
import { isStripped, readImageMetadata } from '../src/image-metadata.js';

/**
 * Synthetic files rather than fixtures on disk.
 *
 * Every buffer below is assembled byte by byte to the format's own spec, so a
 * failure points at the parser rather than at a binary nobody can read in a
 * diff — and the tests state, in code, exactly what shape of file the parser
 * claims to understand.
 */

function bytes(...values: number[]): number[] {
  return values;
}

function asciiBytes(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

function u16be(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function toBuffer(values: number[]): ArrayBuffer {
  return Uint8Array.from(values).buffer;
}

/** A little-endian TIFF block with one ASCII tag, plus optional extra entries. */
function tiffWithMake(make: string, extraTags: { tag: number; pointer: number }[] = []): number[] {
  const entryCount = 1 + extraTags.length;
  const headerLength = 8 + 2 + entryCount * 12 + 4;
  const value = asciiBytes(make).concat([0]);

  const out: number[] = [
    0x49, 0x49, // "II" — little-endian
    0x2a, 0x00, // magic 42
    0x08, 0x00, 0x00, 0x00, // IFD0 at offset 8
    entryCount & 0xff, (entryCount >> 8) & 0xff,
    // Make (0x010F), ASCII, `value.length` characters, at headerLength.
    0x0f, 0x01,
    0x02, 0x00,
    value.length & 0xff, (value.length >> 8) & 0xff, 0x00, 0x00,
    headerLength & 0xff, (headerLength >> 8) & 0xff, 0x00, 0x00,
  ];

  for (const extra of extraTags) {
    out.push(
      extra.tag & 0xff, (extra.tag >> 8) & 0xff,
      0x04, 0x00, // LONG
      0x01, 0x00, 0x00, 0x00,
      extra.pointer & 0xff, (extra.pointer >> 8) & 0xff, 0x00, 0x00,
    );
  }

  out.push(0x00, 0x00, 0x00, 0x00); // no next IFD
  return out.concat(value);
}

function jpeg(options: { exif?: number[]; xmp?: boolean; app11?: boolean } = {}): ArrayBuffer {
  const out: number[] = bytes(0xff, 0xd8);

  if (options.exif) {
    const payload = asciiBytes('Exif').concat([0, 0], options.exif);
    out.push(0xff, 0xe1, ...u16be(payload.length + 2), ...payload);
  }
  if (options.xmp) {
    const payload = asciiBytes('http://ns.adobe.com/xap/1.0/').concat([0]);
    out.push(0xff, 0xe1, ...u16be(payload.length + 2), ...payload);
  }
  if (options.app11) {
    const payload = asciiBytes('JP').concat([0, 0], asciiBytes('jumb'));
    out.push(0xff, 0xeb, ...u16be(payload.length + 2), ...payload);
  }

  // SOF0: precision, height, width, components
  const sof = [8, ...u16be(480), ...u16be(640), 3];
  out.push(0xff, 0xc0, ...u16be(sof.length + 2), ...sof);
  out.push(0xff, 0xd9);
  return toBuffer(out);
}

function pngChunk(type: string, payload: number[]): number[] {
  return [...u32be(payload.length), ...asciiBytes(type), ...payload, 0, 0, 0, 0];
}

function png(chunks: number[][] = []): ArrayBuffer {
  const out: number[] = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  out.push(...pngChunk('IHDR', [...u32be(1024), ...u32be(768), 8, 6, 0, 0, 0]));
  for (const chunk of chunks) out.push(...chunk);
  out.push(...pngChunk('IEND', []));
  return toBuffer(out);
}

describe('format detection', () => {
  it('recognises a JPEG and reads its frame size', () => {
    const meta = readImageMetadata(jpeg());
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
  });

  it('recognises a PNG and reads IHDR', () => {
    const meta = readImageMetadata(png());
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(768);
  });

  it('recognises a WebP and decodes its 24-bit minus-one sizes', () => {
    const vp8x = [0x10, 0, 0, 0, 0x3f, 0x02, 0x00, 0x1f, 0x01, 0x00];
    const payload = asciiBytes('WEBP')
      .concat(asciiBytes('VP8X'), [10, 0, 0, 0], vp8x);
    const out = asciiBytes('RIFF').concat([payload.length & 0xff, 0, 0, 0], payload);
    const meta = readImageMetadata(toBuffer(out));
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(576);
    expect(meta.height).toBe(288);
  });

  it('recognises a GIF', () => {
    const out = asciiBytes('GIF89a').concat([0x20, 0x00, 0x10, 0x00], new Array(8).fill(0));
    const meta = readImageMetadata(toBuffer(out));
    expect(meta.format).toBe('gif');
    expect(meta.width).toBe(32);
    expect(meta.height).toBe(16);
  });

  it('says unknown rather than guessing at something it cannot read', () => {
    const meta = readImageMetadata(toBuffer(new Array(64).fill(0x41)));
    expect(meta.format).toBe('unknown');
    expect(meta.bytes).toBe(64);
  });

  it('does not throw on a file too short to hold a header', () => {
    expect(() => readImageMetadata(toBuffer([0xff, 0xd8]))).not.toThrow();
    expect(readImageMetadata(toBuffer([0xff, 0xd8])).format).toBe('unknown');
  });
});

describe('EXIF', () => {
  it('reads an ASCII tag out of IFD0', () => {
    const meta = readImageMetadata(jpeg({ exif: tiffWithMake('TestCam') }));
    expect(meta.fields).toContainEqual({ id: 'make', value: 'TestCam' });
  });

  it('reports GPS as present without decoding coordinates', () => {
    // 0x8825 is the GPS IFD pointer. Presence is the privacy fact; the numbers
    // themselves are not the page's business.
    const meta = readImageMetadata(
      jpeg({ exif: tiffWithMake('TestCam', [{ tag: 0x8825, pointer: 0 }]) }),
    );
    expect(meta.hasGps).toBe(true);
    expect(JSON.stringify(meta.fields)).not.toContain('8825');
  });

  it('reports no GPS when the tag is absent', () => {
    expect(readImageMetadata(jpeg({ exif: tiffWithMake('TestCam') })).hasGps).toBe(false);
  });

  it('survives a truncated EXIF block', () => {
    const truncated = tiffWithMake('TestCam').slice(0, 14);
    expect(() => readImageMetadata(jpeg({ exif: truncated }))).not.toThrow();
  });

  it('ignores a corrupt entry count instead of walking off the end', () => {
    const tiff = tiffWithMake('TestCam');
    tiff[8] = 0xff;
    tiff[9] = 0xff;
    const meta = readImageMetadata(jpeg({ exif: tiff }));
    expect(meta.fields).toEqual([]);
  });
});

describe('PNG text chunks', () => {
  it('reads a Software keyword', () => {
    const text = asciiBytes('Software').concat([0], asciiBytes('PrismPoster'));
    const meta = readImageMetadata(png([pngChunk('tEXt', text)]));
    expect(meta.fields).toContainEqual({ id: 'software', value: 'PrismPoster' });
  });

  // The keyword generators write their whole prompt into. Surfacing it is the
  // single most useful thing this page does for an image somebody sent you.
  it('reads a generation-parameters chunk', () => {
    const text = asciiBytes('parameters').concat([0], asciiBytes('a cat, 30 steps'));
    const meta = readImageMetadata(png([pngChunk('tEXt', text)]));
    expect(meta.fields).toContainEqual({
      id: 'generationParameters',
      value: 'a cat, 30 steps',
    });
  });

  it('ignores a keyword it has no label for', () => {
    const text = asciiBytes('SomePrivateKey').concat([0], asciiBytes('value'));
    expect(readImageMetadata(png([pngChunk('tEXt', text)])).fields).toEqual([]);
  });
});

describe('provenance', () => {
  it('reports a C2PA manifest carried in a PNG caBX chunk', () => {
    expect(readImageMetadata(png([pngChunk('caBX', [1, 2, 3])])).hasC2pa).toBe(true);
  });

  it('reports a C2PA manifest carried in a JPEG APP11 segment', () => {
    expect(readImageMetadata(jpeg({ app11: true })).hasC2pa).toBe(true);
  });

  it('reports an XMP packet', () => {
    expect(readImageMetadata(jpeg({ xmp: true })).hasXmp).toBe(true);
  });

  // The honest negative. Absence of a manifest is absence of a claim, and the
  // page must never present it as evidence about how the image was made.
  it('reports absence as absence', () => {
    const meta = readImageMetadata(jpeg());
    expect(meta.hasC2pa).toBe(false);
    expect(meta.hasXmp).toBe(false);
    expect(isStripped(meta)).toBe(true);
  });
});

describe('isStripped', () => {
  it('is false as soon as the file carries anything', () => {
    expect(isStripped(readImageMetadata(jpeg({ exif: tiffWithMake('TestCam') })))).toBe(false);
    expect(isStripped(readImageMetadata(jpeg({ xmp: true })))).toBe(false);
  });
});
