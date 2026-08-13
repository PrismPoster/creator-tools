/**
 * Tap tempo, and the beat arithmetic an edit timeline needs.
 *
 * The estimator is deliberately not a plain mean of every interval. A tap
 * sequence has two failure modes that a mean handles badly: the first tap or two
 * are usually late while the user finds the beat, and a single missed tap
 * produces one interval at roughly double the true period, which drags a mean
 * far more than it drags a median. So the default estimator takes the median of
 * a trailing window, and outliers are discarded against that median rather than
 * against the mean they would themselves distort.
 */

/** Slowest and fastest tempi treated as a real tap rather than a stray click. */
export const MIN_BPM = 20;
export const MAX_BPM = 400;

/** Taps older than this (ms) are considered a new attempt, not a continuation. */
export const TAP_TIMEOUT_MS = 2_500;

/** How many recent intervals the estimate is taken over. */
export const DEFAULT_WINDOW = 12;

const msPerBeat = (bpm: number): number => 60_000 / bpm;

/** An interval this long or short cannot be a tap inside the BPM bounds. */
const MAX_INTERVAL_MS = msPerBeat(MIN_BPM);
const MIN_INTERVAL_MS = msPerBeat(MAX_BPM);

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface TempoEstimate {
  readonly bpm: number;
  /** Taps that contributed to this estimate. */
  readonly taps: number;
  /**
   * Mean absolute deviation of the kept intervals from the median, in ms.
   * A steady tapper lands under ~20ms; over ~60ms means the estimate is soft.
   */
  readonly spreadMs: number;
  /** Intervals discarded as outliers (usually a missed or doubled tap). */
  readonly discarded: number;
}

/**
 * Estimate tempo from a list of tap timestamps in milliseconds.
 *
 * Timestamps must be monotonic — pass `performance.now()` values, not
 * `Date.now()`, so a clock adjustment mid-tap cannot produce a negative
 * interval. Returns null until there are at least two usable taps.
 */
export function estimateTempo(
  timestamps: readonly number[],
  window = DEFAULT_WINDOW,
): TempoEstimate | null {
  if (timestamps.length < 2) return null;

  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i += 1) {
    const delta = (timestamps[i] as number) - (timestamps[i - 1] as number);
    // A gap past the timeout means the user restarted; earlier taps are stale.
    if (delta > TAP_TIMEOUT_MS) {
      intervals.length = 0;
      continue;
    }
    if (delta >= MIN_INTERVAL_MS && delta <= MAX_INTERVAL_MS) {
      intervals.push(delta);
    }
  }
  if (intervals.length === 0) return null;

  const recent = intervals.slice(-window);
  const centre = median(recent);
  if (centre === null || centre <= 0) return null;

  // Discard against the median, not the mean: one doubled interval would move
  // a mean far enough to keep itself inside the tolerance.
  const kept = recent.filter((v) => Math.abs(v - centre) <= centre * 0.35);
  const basis = kept.length > 0 ? kept : recent;
  const period = median(basis) as number;

  const spreadMs =
    basis.reduce((sum, v) => sum + Math.abs(v - period), 0) / basis.length;

  return {
    bpm: Math.round((60_000 / period) * 100) / 100,
    taps: timestamps.length,
    spreadMs: Math.round(spreadMs * 100) / 100,
    discarded: recent.length - kept.length,
  };
}

/**
 * Fold a tempo into a target range by halving or doubling.
 *
 * A tapper marking every other beat of a 140 BPM track reads as 70. Musically
 * those are the same tempo, so this is a display convenience, not a correction —
 * only apply it where the user has asked for it.
 */
export function foldTempo(bpm: number, min = 70, max = 180): number | null {
  if (!Number.isFinite(bpm) || bpm <= 0 || min <= 0 || max <= min) return null;
  let value = bpm;
  let guard = 0;
  while (value < min && guard < 16) {
    value *= 2;
    guard += 1;
  }
  while (value > max && guard < 16) {
    value /= 2;
    guard += 1;
  }
  return Math.round(value * 100) / 100;
}

/** Milliseconds per beat at a given tempo. */
export function beatMs(bpm: number): number | null {
  if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) return null;
  return Math.round(msPerBeat(bpm) * 1000) / 1000;
}

/** Milliseconds per bar, defaulting to 4/4. */
export function barMs(bpm: number, beatsPerBar = 4): number | null {
  const beat = beatMs(bpm);
  if (beat === null || !Number.isInteger(beatsPerBar) || beatsPerBar < 1) {
    return null;
  }
  return Math.round(beat * beatsPerBar * 1000) / 1000;
}

/** Note-length divisions relative to a quarter note. */
export const NOTE_DIVISIONS = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  sixteenth: 0.25,
  thirtySecond: 0.125,
} as const;

export type NoteDivision = keyof typeof NOTE_DIVISIONS;

/**
 * Length of a note in milliseconds. `dotted` adds half its value again;
 * `triplet` takes two thirds. Passing both is rejected rather than guessed at.
 */
export function noteMs(
  bpm: number,
  division: NoteDivision,
  options: { dotted?: boolean; triplet?: boolean } = {},
): number | null {
  const beat = beatMs(bpm);
  if (beat === null) return null;
  if (options.dotted && options.triplet) return null;
  let value = beat * NOTE_DIVISIONS[division];
  if (options.dotted) value *= 1.5;
  if (options.triplet) value *= 2 / 3;
  return Math.round(value * 1000) / 1000;
}

/**
 * Beat timestamps in milliseconds across a duration, starting at `offsetMs`.
 *
 * Positions are computed from the beat index rather than accumulated, so a long
 * sequence cannot drift: adding a rounded period 4,000 times compounds the
 * rounding error, multiplying by the index does not.
 */
export function beatGrid(
  bpm: number,
  durationMs: number,
  offsetMs = 0,
): number[] | null {
  const period = beatMs(bpm);
  if (period === null || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  const out: number[] = [];
  for (let i = 0; ; i += 1) {
    const t = offsetMs + i * period;
    if (t > durationMs) break;
    if (t >= 0) out.push(Math.round(t * 1000) / 1000);
    if (out.length > 100_000) break;
  }
  return out;
}

/**
 * Snap a time to the nearest beat, returning the snapped time and the distance
 * moved. A cut more than half a beat away from the grid is usually intentional,
 * so callers can use `deltaMs` to decide whether to apply the snap at all.
 */
export function snapToBeat(
  timeMs: number,
  bpm: number,
  offsetMs = 0,
): { readonly timeMs: number; readonly deltaMs: number } | null {
  const period = beatMs(bpm);
  if (period === null || !Number.isFinite(timeMs)) return null;
  const index = Math.round((timeMs - offsetMs) / period);
  const snapped = offsetMs + index * period;
  return {
    timeMs: Math.round(snapped * 1000) / 1000,
    deltaMs: Math.round((snapped - timeMs) * 1000) / 1000,
  };
}
