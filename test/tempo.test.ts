import { describe, expect, it } from 'vitest';
import {
  barMs,
  beatGrid,
  beatMs,
  estimateTempo,
  foldTempo,
  noteMs,
  snapToBeat,
} from '../src/tempo.js';

/** Tap timestamps at an exact tempo, optionally with jitter applied. */
function taps(bpm: number, count: number, jitter = 0): number[] {
  const period = 60_000 / bpm;
  return Array.from({ length: count }, (_, i) => {
    const wobble = jitter === 0 ? 0 : ((i * 7919) % 100) / 100 - 0.5;
    return i * period + wobble * jitter;
  });
}

describe('estimateTempo', () => {
  it('needs at least two taps', () => {
    expect(estimateTempo([0])).toBeNull();
  });

  it('recovers an exact tempo', () => {
    expect(estimateTempo(taps(120, 8))?.bpm).toBe(120);
  });

  it('stays close under human jitter', () => {
    const result = estimateTempo(taps(128, 16, 25));
    expect(result).not.toBeNull();
    expect(Math.abs((result as { bpm: number }).bpm - 128)).toBeLessThan(3);
  });

  it('is not dragged off by a single missed tap', () => {
    // Drop one tap so a doubled interval appears mid-sequence. A mean-based
    // estimator lands near 110; the median-based one should hold near 120.
    const sequence = taps(120, 12);
    sequence.splice(6, 1);
    const result = estimateTempo(sequence);
    expect(Math.abs((result as { bpm: number }).bpm - 120)).toBeLessThan(2);
    expect((result as { discarded: number }).discarded).toBeGreaterThan(0);
  });

  it('restarts after a long pause instead of averaging across it', () => {
    const first = taps(90, 4);
    const later = taps(150, 6).map((t) => t + 20_000);
    const result = estimateTempo([...first, ...later]);
    expect(Math.abs((result as { bpm: number }).bpm - 150)).toBeLessThan(2);
  });

  it('reports spread so a caller can tell a soft estimate from a firm one', () => {
    const steady = estimateTempo(taps(120, 12)) as { spreadMs: number };
    const sloppy = estimateTempo(taps(120, 12, 60)) as { spreadMs: number };
    expect(steady.spreadMs).toBeLessThan(sloppy.spreadMs);
  });

  it('ignores taps faster or slower than any real tempo', () => {
    expect(estimateTempo([0, 1, 2, 3])).toBeNull();
  });
});

describe('foldTempo', () => {
  it('doubles a half-time tap into range', () => {
    expect(foldTempo(60)).toBe(120);
  });

  it('treats the range as inclusive at its lower bound', () => {
    expect(foldTempo(70)).toBe(70);
  });

  it('halves a double-time tap into range', () => {
    expect(foldTempo(240)).toBe(120);
  });

  it('leaves an in-range tempo alone', () => {
    expect(foldTempo(128)).toBe(128);
  });
});

describe('beat arithmetic', () => {
  it('gives 500ms per beat at 120 BPM', () => {
    expect(beatMs(120)).toBe(500);
  });

  it('gives 2000ms per 4/4 bar at 120 BPM', () => {
    expect(barMs(120)).toBe(2000);
  });

  it('handles an odd meter', () => {
    expect(barMs(120, 7)).toBe(3500);
  });

  it('rejects a tempo outside the sane range', () => {
    expect(beatMs(1000)).toBeNull();
    expect(beatMs(0)).toBeNull();
  });
});

describe('noteMs', () => {
  it('computes a sixteenth at 120 BPM', () => {
    expect(noteMs(120, 'sixteenth')).toBe(125);
  });

  it('adds half again for a dotted note', () => {
    expect(noteMs(120, 'quarter', { dotted: true })).toBe(750);
  });

  it('takes two thirds for a triplet', () => {
    expect(noteMs(120, 'quarter', { triplet: true })).toBeCloseTo(333.333, 2);
  });

  it('refuses to guess at dotted AND triplet', () => {
    expect(noteMs(120, 'quarter', { dotted: true, triplet: true })).toBeNull();
  });
});

describe('beatGrid', () => {
  it('lays beats across a duration without drifting', () => {
    const grid = beatGrid(120, 10_000) as number[];
    expect(grid[0]).toBe(0);
    expect(grid).toHaveLength(21);
    // The last beat must be exactly 20 periods out, not an accumulation.
    expect(grid[20]).toBe(10_000);
  });

  it('respects an offset', () => {
    const grid = beatGrid(120, 2_000, 250) as number[];
    expect(grid[0]).toBe(250);
  });
});

describe('snapToBeat', () => {
  it('snaps forward to the nearest beat and reports the distance', () => {
    const snapped = snapToBeat(480, 120);
    expect(snapped?.timeMs).toBe(500);
    expect(snapped?.deltaMs).toBe(20);
  });

  it('snaps backward when that is nearer', () => {
    expect(snapToBeat(520, 120)?.timeMs).toBe(500);
  });
});
