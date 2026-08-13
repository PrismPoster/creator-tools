import { describe, expect, it } from 'vitest';
import {
  convert,
  deoverlap,
  detectFormat,
  formatAssTimestamp,
  formatSrtTimestamp,
  parse,
  parseAss,
  parseSrt,
  parseTimestamp,
  parseVtt,
  scale,
  shift,
  toSrt,
  toVtt,
} from '../src/subtitles.js';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello there.

2
00:00:04,000 --> 00:00:06,000
Second line
across two rows.
`;

const VTT = `WEBVTT

NOTE this is metadata and must not become a cue

00:00:01.000 --> 00:00:03.500
<v Roger>Hello there.

00:00:04.000 --> 00:00:06.000
Second line
`;

const ASS = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}Hello there.
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Second line\\Nacross two rows.
`;

describe('parseTimestamp', () => {
  it('reads SRT comma form', () => {
    expect(parseTimestamp('00:00:01,500')).toBe(1500);
  });

  it('reads VTT dot form', () => {
    expect(parseTimestamp('01:02:03.004')).toBe(3_723_004);
  });

  it('reads the hourless VTT short form', () => {
    expect(parseTimestamp('02:03.500')).toBe(123_500);
  });

  it('rejects nonsense', () => {
    expect(parseTimestamp('later on')).toBeNull();
  });
});

describe('parseSrt', () => {
  it('reads cues, indices, and multi-line text', () => {
    const { cues, warnings } = parseSrt(SRT);
    expect(warnings).toHaveLength(0);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ index: 1, startMs: 1000, endMs: 3500 });
    expect(cues[1]?.text).toBe('Second line\nacross two rows.');
  });

  it('survives a UTF-8 BOM', () => {
    expect(parseSrt(`﻿${SRT}`).cues).toHaveLength(2);
  });

  it('survives CRLF line endings', () => {
    expect(parseSrt(SRT.replace(/\n/g, '\r\n')).cues).toHaveLength(2);
  });

  it('keeps good cues when one block is malformed', () => {
    const broken = `${SRT}\n3\nnot a timing line\nOrphan text\n`;
    const { cues, warnings } = parseSrt(broken);
    expect(cues).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });
});

describe('parseVtt', () => {
  it('skips NOTE blocks and strips inline tags', () => {
    const { cues } = parseVtt(VTT);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toBe('Hello there.');
  });

  it('warns but still parses when the header is missing', () => {
    const { cues, warnings } = parseVtt(VTT.replace('WEBVTT\n\n', ''));
    expect(cues.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/WEBVTT/);
  });
});

describe('parseAss', () => {
  it('reads dialogue, strips override blocks, and converts \\N', () => {
    const { cues } = parseAss(ASS);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toBe('Hello there.');
    expect(cues[1]?.text).toBe('Second line\nacross two rows.');
  });

  it('keeps commas that belong to the text', () => {
    const line =
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,One, two, three.';
    const { cues } = parseAss(`[Events]\n${line}`);
    expect(cues[0]?.text).toBe('One, two, three.');
  });
});

describe('detectFormat', () => {
  it('identifies each format', () => {
    expect(detectFormat(SRT)).toBe('srt');
    expect(detectFormat(VTT)).toBe('vtt');
    expect(detectFormat(ASS)).toBe('ass');
  });

  it('returns null rather than guessing', () => {
    expect(detectFormat('just some prose')).toBeNull();
  });
});

describe('conversion', () => {
  it('round-trips SRT through VTT without losing timing', () => {
    const vtt = toVtt(parseSrt(SRT).cues);
    const back = parseVtt(vtt).cues;
    expect(back[0]?.startMs).toBe(1000);
    expect(back[0]?.endMs).toBe(3500);
  });

  it('renumbers SRT indices sequentially on output', () => {
    const out = toSrt(parseVtt(VTT).cues);
    expect(out.startsWith('1\n')).toBe(true);
    expect(out).toContain('\n2\n');
  });

  it('warns that ASS output loses sub-centisecond precision', () => {
    const { warnings } = convert(SRT, 'ass');
    expect(warnings.some((w) => /centisecond/i.test(w))).toBe(true);
  });

  it('rounds to centiseconds in ASS timestamps', () => {
    expect(formatAssTimestamp(1_234)).toBe('0:00:01.23');
    expect(formatSrtTimestamp(1_234)).toBe('00:00:01,234');
  });

  it('reports an unrecognised format instead of returning empty silently', () => {
    const { warnings } = parse('just some prose');
    expect(warnings[0]).toMatch(/Unrecognised/);
  });
});

describe('editing', () => {
  it('shifts every cue', () => {
    const shifted = shift(parseSrt(SRT).cues, 500);
    expect(shifted[0]?.startMs).toBe(1500);
  });

  it('clamps at zero rather than producing negative times', () => {
    const shifted = shift(parseSrt(SRT).cues, -5_000);
    expect(shifted[0]?.startMs).toBe(0);
  });

  it('rescales for a frame-rate change', () => {
    const rescaled = scale(parseSrt(SRT).cues, 23.976 / 25) as Array<{
      startMs: number;
    }>;
    expect(rescaled[0]?.startMs).toBe(959);
  });

  it('rejects a non-positive scale factor', () => {
    expect(scale(parseSrt(SRT).cues, 0)).toBeNull();
  });

  it('clips overlapping cues so only one is on screen', () => {
    const overlapping = [
      { startMs: 0, endMs: 5_000, text: 'a' },
      { startMs: 3_000, endMs: 6_000, text: 'b' },
    ];
    const fixed = deoverlap(overlapping);
    expect(fixed[0]?.endMs).toBe(3_000);
  });
});
