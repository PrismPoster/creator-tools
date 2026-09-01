/**
 * Metadata reading for /tools/image-metadata-viewer.
 *
 * Pure and dependency-free like the rest of `lib/tools/`: this takes the bytes
 * of a file and returns what the file says about itself. The widget supplies the
 * ArrayBuffer, so the whole parser is testable without a DOM or a fixture on
 * disk.
 *
 * What this deliberately does NOT do is guess. It reports the provenance a file
 * actually carries — a C2PA manifest, an XMP block, a generator's name in a PNG
 * text chunk — and reports its absence as absence. There is no honest way to
 * look at pixels and say "this was generated", and a page that implied otherwise
 * would be the one thing our own AI-disclosure position rules out.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'unknown';

export interface MetadataField {
  /** Stable id, so the UI can translate the label instead of printing English. */
  readonly id: string;
  readonly value: string;
}

export interface ImageMetadata {
  readonly format: ImageFormat;
  readonly width: number | null;
  readonly height: number | null;
  /** Camera, software and timestamp fields that were actually present. */
  readonly fields: readonly MetadataField[];
  /** The file carries GPS coordinates. Not decoded — presence is the point. */
  readonly hasGps: boolean;
  /** An XMP packet is present (Adobe's metadata container). */
  readonly hasXmp: boolean;
  /** A C2PA / Content Credentials manifest is present. */
  readonly hasC2pa: boolean;
  /** Total bytes of the file, so "how much of this is metadata" is answerable. */
  readonly bytes: number;
}

const EXIF_TAGS: Record<number, string> = {
  0x010f: 'make',
  0x0110: 'model',
  0x0131: 'software',
  0x0132: 'dateTime',
  0x013b: 'artist',
  0x8298: 'copyright',
};

/** Tags inside the Exif sub-IFD worth surfacing. */
const EXIF_SUB_TAGS: Record<number, string> = {
  0x9003: 'dateTaken',
  0xa434: 'lens',
};

const GPS_IFD_POINTER = 0x8825;
const EXIF_IFD_POINTER = 0x8769;

function ascii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    // Keep it to printable ASCII: EXIF strings from cheap devices are frequently
    // padded with junk, and a control character in the UI is worse than a trim.
    if (code >= 32 && code < 127) out += String.fromCharCode(code);
  }
  return out.trim();
}

function startsWith(view: DataView, offset: number, text: string): boolean {
  if (offset + text.length > view.byteLength) return false;
  for (let i = 0; i < text.length; i++) {
    if (view.getUint8(offset + i) !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Case-insensitive search for an ASCII needle over the whole buffer. */
function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const lower = needle.toLowerCase();
  const first = lower.charCodeAt(0);
  const upperFirst = needle.toUpperCase().charCodeAt(0);
  for (let i = 0; i + lower.length <= bytes.length; i++) {
    const byte = bytes[i];
    if (byte !== first && byte !== upperFirst) continue;
    let hit = true;
    for (let j = 1; j < lower.length; j++) {
      const candidate = (bytes[i + j] ?? -1) | 0x20;
      if (candidate !== lower.charCodeAt(j)) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

interface IfdResult {
  readonly fields: MetadataField[];
  readonly hasGps: boolean;
}

function readIfd(
  view: DataView,
  tiffStart: number,
  ifdOffset: number,
  little: boolean,
  tags: Record<number, string>,
  depth: number,
): IfdResult {
  const fields: MetadataField[] = [];
  let hasGps = false;

  const at = tiffStart + ifdOffset;
  if (at + 2 > view.byteLength) return { fields, hasGps };

  const count = view.getUint16(at, little);
  // A corrupt count would walk us off the end; the format allows no more than a
  // few hundred entries in practice.
  if (count > 512) return { fields, hasGps };

  for (let i = 0; i < count; i++) {
    const entry = at + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;

    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const length = view.getUint32(entry + 4, little);

    if (tag === GPS_IFD_POINTER) {
      hasGps = true;
      continue;
    }

    if (tag === EXIF_IFD_POINTER && depth === 0) {
      const pointer = view.getUint32(entry + 8, little);
      const nested = readIfd(view, tiffStart, pointer, little, EXIF_SUB_TAGS, depth + 1);
      fields.push(...nested.fields);
      hasGps = hasGps || nested.hasGps;
      continue;
    }

    const id = tags[tag];
    if (!id) continue;

    // ASCII is the only type any of the surfaced tags uses. A value of four
    // bytes or fewer lives in the entry itself; anything longer is a pointer.
    if (type !== 2 || length === 0) continue;
    const valueOffset =
      length <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, little);
    if (valueOffset + Math.min(length, 256) > view.byteLength) continue;

    const value = ascii(view, valueOffset, Math.min(length, 256));
    if (value) fields.push({ id, value });
  }

  return { fields, hasGps };
}

function readExif(view: DataView, tiffStart: number): IfdResult {
  if (tiffStart + 8 > view.byteLength) return { fields: [], hasGps: false };

  const order = view.getUint16(tiffStart, false);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return { fields: [], hasGps: false };

  if (view.getUint16(tiffStart + 2, little) !== 0x002a) return { fields: [], hasGps: false };

  const ifdOffset = view.getUint32(tiffStart + 4, little);
  return readIfd(view, tiffStart, ifdOffset, little, EXIF_TAGS, 0);
}

function readJpeg(view: DataView, bytes: Uint8Array): ImageMetadata {
  let width: number | null = null;
  let height: number | null = null;
  let fields: MetadataField[] = [];
  let hasGps = false;
  let hasXmp = false;
  let hasC2pa = false;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // scan data: metadata is behind us

    const length = view.getUint16(offset + 2, false);
    const payload = offset + 4;
    if (length < 2 || payload + length - 2 > view.byteLength) break;

    if (marker === 0xe1) {
      if (startsWith(view, payload, 'Exif\0\0')) {
        const result = readExif(view, payload + 6);
        fields = fields.concat(result.fields);
        hasGps = hasGps || result.hasGps;
      } else if (startsWith(view, payload, 'http://ns.adobe.com/xap/1.0/')) {
        hasXmp = true;
      }
    } else if (marker === 0xeb) {
      // APP11 is where a JUMBF box, and therefore a C2PA manifest, is carried.
      hasC2pa = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // A start-of-frame marker: the only place a JPEG states its size.
      if (payload + 5 <= view.byteLength) {
        height = view.getUint16(payload + 1, false);
        width = view.getUint16(payload + 3, false);
      }
    }

    offset = payload + length - 2;
  }

  return {
    format: 'jpeg',
    width,
    height,
    fields,
    hasGps,
    hasXmp: hasXmp || containsAscii(bytes, 'ns.adobe.com/xap'),
    hasC2pa: hasC2pa || containsAscii(bytes, 'c2pa'),
    bytes: bytes.length,
  };
}

/** PNG text keywords worth surfacing, lower-cased. */
const PNG_TEXT_KEYS: Record<string, string> = {
  software: 'software',
  author: 'artist',
  copyright: 'copyright',
  description: 'description',
  comment: 'comment',
  parameters: 'generationParameters',
  prompt: 'generationParameters',
  'creation time': 'dateTime',
};

function readPng(view: DataView, bytes: Uint8Array): ImageMetadata {
  const fields: MetadataField[] = [];
  let width: number | null = null;
  let height: number | null = null;
  let hasXmp = false;
  let hasC2pa = false;

  let offset = 8;
  while (offset + 8 <= view.byteLength) {
    const length = view.getUint32(offset, false);
    const type = ascii(view, offset + 4, 4);
    const payload = offset + 8;
    if (payload + length > view.byteLength) break;

    if (type === 'IHDR' && length >= 8) {
      width = view.getUint32(payload, false);
      height = view.getUint32(payload + 4, false);
    } else if (type === 'tEXt' || type === 'iTXt') {
      const text = ascii(view, payload, Math.min(length, 1024));
      // Both chunk types are keyword, NUL, then the value; `ascii` stops at the
      // NUL, so the keyword is what came back and the value follows it.
      const keyword = text.toLowerCase();
      const id = PNG_TEXT_KEYS[keyword];
      if (id) {
        const valueStart = payload + text.length + 1;
        const value = ascii(view, valueStart, Math.min(length - text.length - 1, 512));
        if (value) fields.push({ id, value });
      }
      if (keyword === 'xml:com.adobe.xmp') hasXmp = true;
    } else if (type === 'caBX') {
      // The JUMBF box PNG uses to carry Content Credentials.
      hasC2pa = true;
    } else if (type === 'IEND') {
      break;
    }

    offset = payload + length + 4; // payload plus the CRC
  }

  return {
    format: 'png',
    width,
    height,
    fields,
    hasGps: false,
    hasXmp: hasXmp || containsAscii(bytes, 'ns.adobe.com/xap'),
    hasC2pa: hasC2pa || containsAscii(bytes, 'c2pa'),
    bytes: bytes.length,
  };
}

function readWebp(view: DataView, bytes: Uint8Array): ImageMetadata {
  let width: number | null = null;
  let height: number | null = null;
  let fields: MetadataField[] = [];
  let hasGps = false;
  let hasXmp = false;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const type = ascii(view, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + length > view.byteLength) break;

    if (type === 'VP8X' && length >= 10) {
      // Sizes are stored minus one, as 24-bit little-endian.
      width =
        1 + (view.getUint8(payload + 4) | (view.getUint8(payload + 5) << 8) | (view.getUint8(payload + 6) << 16));
      height =
        1 + (view.getUint8(payload + 7) | (view.getUint8(payload + 8) << 8) | (view.getUint8(payload + 9) << 16));
    } else if (type === 'EXIF') {
      const result = readExif(view, payload);
      fields = fields.concat(result.fields);
      hasGps = hasGps || result.hasGps;
    } else if (type === 'XMP ') {
      hasXmp = true;
    }

    // RIFF chunks are padded to an even length.
    offset = payload + length + (length % 2);
  }

  return {
    format: 'webp',
    width,
    height,
    fields,
    hasGps,
    hasXmp,
    hasC2pa: containsAscii(bytes, 'c2pa'),
    bytes: bytes.length,
  };
}

/**
 * Read whatever the file says about itself.
 *
 * Never throws on a malformed file: a truncated or hostile buffer returns the
 * fields it managed to read rather than failing the whole page, because "this
 * file is damaged" is itself something the visitor wants to be told.
 */
export function readImageMetadata(buffer: ArrayBuffer): ImageMetadata {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const empty: ImageMetadata = {
    format: 'unknown',
    width: null,
    height: null,
    fields: [],
    hasGps: false,
    hasXmp: false,
    hasC2pa: false,
    bytes: bytes.length,
  };

  if (bytes.length < 12) return empty;

  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(view, bytes);
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return readPng(view, bytes);
    }
    if (startsWith(view, 0, 'RIFF') && startsWith(view, 8, 'WEBP')) return readWebp(view, bytes);
    if (startsWith(view, 0, 'GIF8')) {
      return {
        ...empty,
        format: 'gif',
        width: view.getUint16(6, true),
        height: view.getUint16(8, true),
      };
    }
  } catch {
    // A malformed file that walks a read off the end is still a file the visitor
    // wants an answer about. Fall through to what we know: its size.
    return empty;
  }

  return empty;
}

/** True when the file carries nothing at all beyond its pixels. */
export function isStripped(metadata: ImageMetadata): boolean {
  return (
    metadata.fields.length === 0 &&
    !metadata.hasGps &&
    !metadata.hasXmp &&
    !metadata.hasC2pa
  );
}
