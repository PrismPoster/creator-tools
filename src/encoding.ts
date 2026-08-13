/**
 * Encoding arithmetic: file size, bitrate, timecode, and frame counts.
 *
 * The unit convention matters and is stated once here rather than argued about
 * per function: **bitrates are decimal** (1 Mbps = 1,000,000 bits/second,
 * as every encoder and platform spec means it) and **file sizes are binary**
 * (1 MiB = 1,048,576 bytes, as every operating system reports it). Mixing the
 * two is the reason online calculators disagree by about 5% — so `fileSizeBytes`
 * returns bytes, and formatting to MiB or MB is an explicit, separate choice.
 */

/** Frame rates that need exact rational handling rather than a float. */
export const NTSC_RATES = {
  '23.976': 24000 / 1001,
  '29.97': 30000 / 1001,
  '59.94': 60000 / 1001,
} as const;

export const COMMON_FRAME_RATES = [
  23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120,
] as const;

const isPositive = (n: number): boolean => Number.isFinite(n) && n > 0;

/* -------------------------------------------------------------- size/bitrate */

/**
 * Encoded size in bytes for a duration at a total bitrate.
 *
 * `totalKbps` is video *plus* audio. Forgetting the audio track is the most
 * common reason a delivery lands over a hard size cap, so this takes the sum
 * deliberately rather than a video-only figure.
 */
export function fileSizeBytes(durationSec: number, totalKbps: number): number | null {
  if (!isPositive(durationSec) || !isPositive(totalKbps)) return null;
  return Math.round((totalKbps * 1000 * durationSec) / 8);
}

/** The total bitrate that lands a duration on a target size. */
export function targetBitrateKbps(
  durationSec: number,
  targetBytes: number,
): number | null {
  if (!isPositive(durationSec) || !isPositive(targetBytes)) return null;
  return Math.round(((targetBytes * 8) / durationSec / 1000) * 100) / 100;
}

/**
 * Split a total bitrate into video and audio components.
 * Returns null if the audio track alone exceeds the budget.
 */
export function splitBitrate(
  totalKbps: number,
  audioKbps = 128,
): { readonly videoKbps: number; readonly audioKbps: number } | null {
  if (!isPositive(totalKbps) || !isPositive(audioKbps)) return null;
  const videoKbps = Math.round((totalKbps - audioKbps) * 100) / 100;
  return videoKbps > 0 ? { videoKbps, audioKbps } : null;
}

/**
 * Bits per pixel per frame — the density figure that tells you whether a
 * bitrate is plausible for a resolution, independent of codec.
 *
 * Rough H.264 guidance: below ~0.05 expect visible artefacts on motion, 0.1 is
 * a comfortable delivery target, above ~0.2 is largely wasted on most content.
 */
export function bitsPerPixel(
  widthPx: number,
  heightPx: number,
  fps: number,
  videoKbps: number,
): number | null {
  if (
    !isPositive(widthPx) ||
    !isPositive(heightPx) ||
    !isPositive(fps) ||
    !isPositive(videoKbps)
  ) {
    return null;
  }
  const value = (videoKbps * 1000) / (widthPx * heightPx * fps);
  return Math.round(value * 10_000) / 10_000;
}

/** Uncompressed size of a raw frame at a given bit depth and subsampling. */
export function rawFrameBytes(
  widthPx: number,
  heightPx: number,
  bitsPerSample = 8,
  samplesPerPixel = 3,
): number | null {
  if (!isPositive(widthPx) || !isPositive(heightPx)) return null;
  if (!isPositive(bitsPerSample) || !isPositive(samplesPerPixel)) return null;
  return Math.ceil((widthPx * heightPx * bitsPerSample * samplesPerPixel) / 8);
}

/* --------------------------------------------------------------- formatting */

/** Binary units, as an operating system reports them. */
export function formatBytesBinary(bytes: number, precision = 2): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : precision)} ${units[unit]}`;
}

/** Decimal units, as storage vendors and platform limits state them. */
export function formatBytesDecimal(bytes: number, precision = 2): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : precision)} ${units[unit]}`;
}

/* ---------------------------------------------------------------- timecodes */

/** Whole frames in a duration. Partial trailing frames are truncated. */
export function frameCount(durationSec: number, fps: number): number | null {
  if (!isPositive(durationSec) || !isPositive(fps)) return null;
  return Math.floor(durationSec * fps + 1e-9);
}

/** Duration in seconds of a frame count. */
export function framesToSeconds(frames: number, fps: number): number | null {
  if (!Number.isInteger(frames) || frames < 0 || !isPositive(fps)) return null;
  return Math.round((frames / fps) * 1_000_000) / 1_000_000;
}

/**
 * Non-drop-frame timecode, `HH:MM:SS:FF`.
 *
 * At 29.97 this drifts from wall clock by ~3.6 seconds per hour, which is
 * exactly what drop-frame timecode exists to correct — use `toDropFrame` when
 * the timecode has to match real elapsed time.
 */
export function toTimecode(frames: number, fps: number): string | null {
  if (!Number.isInteger(frames) || frames < 0 || !isPositive(fps)) return null;
  const nominal = Math.round(fps);
  const f = frames % nominal;
  const totalSec = Math.floor(frames / nominal);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

/**
 * Drop-frame timecode, `HH:MM:SS;FF`, for 29.97 and 59.94.
 *
 * Drop-frame skips *labels*, never actual frames: numbers 00 and 01 are omitted
 * at the start of each minute except every tenth minute. Returns null for rates
 * where drop-frame is undefined.
 */
export function toDropFrame(frames: number, fps: number): string | null {
  if (!Number.isInteger(frames) || frames < 0) return null;
  const nominal = Math.round(fps);
  if (nominal !== 30 && nominal !== 60) return null;

  const dropPerMinute = nominal === 30 ? 2 : 4;
  const framesPer10Min = nominal * 60 * 10 - dropPerMinute * 9;
  const framesPerMin = nominal * 60 - dropPerMinute;

  const tenMinBlocks = Math.floor(frames / framesPer10Min);
  let remainder = frames % framesPer10Min;

  // The first minute of each ten-minute block drops nothing.
  let minutes = tenMinBlocks * 10;
  if (remainder >= nominal * 60) {
    remainder -= nominal * 60;
    minutes += 1;
    minutes += Math.floor(remainder / framesPerMin);
    remainder %= framesPerMin;
    remainder += dropPerMinute;
  }

  const f = remainder % nominal;
  const s = Math.floor(remainder / nominal);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(minutes / 60))}:${p(minutes % 60)}:${p(s)};${p(f)}`;
}

/** Parse `HH:MM:SS:FF` or `HH:MM:SS;FF` back to a non-drop frame count. */
export function parseTimecode(timecode: string, fps: number): number | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(timecode.trim());
  if (!match || !isPositive(fps)) return null;
  const nominal = Math.round(fps);
  const [, h, m, s, f] = match;
  const frames = Number(f);
  if (frames >= nominal) return null;
  return (
    ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * nominal + frames
  );
}
