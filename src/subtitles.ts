/**
 * Subtitle parsing and conversion between SRT, WebVTT, and ASS/SSA.
 *
 * Everything routes through one neutral `Cue` shape rather than converting
 * format-to-format directly. Six formats would otherwise need thirty converters,
 * and each pairwise converter is somewhere a rounding rule can quietly differ.
 *
 * Timings are milliseconds throughout. ASS stores centiseconds, so an
 * ASS round-trip is lossy below 10ms — that is the format's limitation, not a
 * bug here, and `assRoundTripLossMs` lets a caller warn about it up front.
 */

export interface Cue {
  /** 1-based index as it appeared in the source, if the format carries one. */
  readonly index?: number;
  readonly startMs: number;
  readonly endMs: number;
  /** Cue text with newlines preserved and format-specific markup stripped. */
  readonly text: string;
}

export type SubtitleFormat = 'srt' | 'vtt' | 'ass';

export interface ParseResult {
  readonly cues: readonly Cue[];
  /**
   * Non-fatal problems: a malformed block, an out-of-order cue, a negative
   * duration. Parsing continues past these — a single bad cue in a 900-cue file
   * should not cost the user the other 899.
   */
  readonly warnings: readonly string[];
}

/** ASS stores time to centisecond precision. */
export const ASS_ROUND_TRIP_LOSS_MS = 10;

function clampMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/* ---------------------------------------------------------------- timecodes */

/** `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` / `MM:SS.mmm` (VTT) to milliseconds. */
export function parseTimestamp(input: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(
    input.trim(),
  );
  if (!match) return null;
  const [, h, m, s, frac] = match;
  const ms = Number(frac?.padEnd(3, '0'));
  const total =
    Number(h ?? 0) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1_000 + ms;
  return Number.isFinite(total) ? total : null;
}

function pad(n: number, width = 2): string {
  return String(Math.floor(n)).padStart(width, '0');
}

function parts(totalMs: number) {
  const ms = Math.max(0, Math.round(totalMs));
  return {
    h: Math.floor(ms / 3_600_000),
    m: Math.floor(ms / 60_000) % 60,
    s: Math.floor(ms / 1_000) % 60,
    ms: ms % 1_000,
  };
}

export function formatSrtTimestamp(totalMs: number): string {
  const { h, m, s, ms } = parts(totalMs);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function formatVttTimestamp(totalMs: number): string {
  const { h, m, s, ms } = parts(totalMs);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** ASS uses `H:MM:SS.cc` — one hour digit, centiseconds. */
export function formatAssTimestamp(totalMs: number): string {
  const { h, m, s, ms } = parts(totalMs);
  return `${Math.floor(h)}:${pad(m)}:${pad(s)}.${pad(Math.floor(ms / 10), 2)}`;
}

/* ------------------------------------------------------------------ parsing */

function normalise(input: string): string {
  // Strip a UTF-8 BOM and normalise CRLF; a BOM left in place makes the first
  // cue index unparseable and silently drops cue 1.
  return input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export function parseSrt(input: string): ParseResult {
  const cues: Cue[] = [];
  const warnings: string[] = [];
  const blocks = normalise(input).trim().split(/\n{2,}/);

  for (const [i, block] of blocks.entries()) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    let cursor = 0;

    let index: number | undefined;
    const first = lines[0]?.trim() ?? '';
    if (/^\d+$/.test(first)) {
      index = Number(first);
      cursor = 1;
    }

    const timing = lines[cursor]?.trim() ?? '';
    const arrow = timing.split('-->');
    if (arrow.length !== 2) {
      warnings.push(`Block ${i + 1}: no timing line, skipped.`);
      continue;
    }
    const startMs = parseTimestamp(arrow[0] as string);
    // Trim before splitting: the text after `-->` starts with a space, and
    // splitting on whitespace first yields a leading empty field, not the
    // timestamp. Any trailing SRT position data ("X1:… Y1:…") drops here.
    const endMs = parseTimestamp((arrow[1] as string).trim().split(/\s+/)[0] ?? '');
    if (startMs === null || endMs === null) {
      warnings.push(`Block ${i + 1}: unparseable timestamp, skipped.`);
      continue;
    }
    if (endMs < startMs) {
      warnings.push(`Block ${i + 1}: end precedes start; cue kept as-is.`);
    }

    const text = lines.slice(cursor + 1).join('\n').trim();
    cues.push(index === undefined ? { startMs, endMs, text } : { index, startMs, endMs, text });
  }

  return { cues, warnings };
}

export function parseVtt(input: string): ParseResult {
  const cues: Cue[] = [];
  const warnings: string[] = [];
  let body = normalise(input).trim();

  if (body.startsWith('WEBVTT')) {
    body = body.slice(body.indexOf('\n') + 1).trim();
  } else {
    warnings.push('Missing WEBVTT header; parsed anyway.');
  }

  for (const block of body.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // NOTE and STYLE blocks are metadata, not cues.
    if (/^(NOTE|STYLE|REGION)\b/.test(trimmed)) continue;

    const lines = trimmed.split('\n');
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue;

    const arrow = (lines[timingIndex] as string).split('-->');
    const startMs = parseTimestamp(arrow[0] as string);
    const endMs = parseTimestamp((arrow[1] as string).trim().split(/\s+/)[0] ?? '');
    if (startMs === null || endMs === null) {
      warnings.push('Unparseable VTT timestamp, cue skipped.');
      continue;
    }

    // Inline tags (<v Roger>, <i>, <c.yellow>) are presentational; the neutral
    // Cue carries plain text, so they are stripped rather than half-translated.
    const text = lines
      .slice(timingIndex + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();

    cues.push({ startMs, endMs, text });
  }

  return { cues, warnings };
}

export function parseAss(input: string): ParseResult {
  const cues: Cue[] = [];
  const warnings: string[] = [];
  const lines = normalise(input).split('\n');

  const formatLine = lines.find((l) => /^Format:/i.test(l.trim()) );
  let startCol = 1;
  let endCol = 2;
  let textCol = 9;

  if (formatLine) {
    const fields = formatLine
      .slice(formatLine.indexOf(':') + 1)
      .split(',')
      .map((f) => f.trim().toLowerCase());
    const s = fields.indexOf('start');
    const e = fields.indexOf('end');
    const t = fields.indexOf('text');
    if (s !== -1) startCol = s;
    if (e !== -1) endCol = e;
    if (t !== -1) textCol = t;
  } else {
    warnings.push('No Format: line found; assumed standard ASS column order.');
  }

  for (const line of lines) {
    if (!/^Dialogue:/i.test(line.trim())) continue;
    // Text is always last and may itself contain commas, so the split is
    // bounded: everything from textCol onwards rejoins.
    const fields = line.slice(line.indexOf(':') + 1).split(',');
    const startMs = parseTimestamp((fields[startCol] ?? '').trim());
    const endMs = parseTimestamp((fields[endCol] ?? '').trim());
    if (startMs === null || endMs === null) {
      warnings.push('Unparseable ASS Dialogue timing, line skipped.');
      continue;
    }
    const text = fields
      .slice(textCol)
      .join(',')
      .replace(/\{[^}]*\}/g, '') // override blocks
      .replace(/\\N/g, '\n')
      .replace(/\\[nh]/g, ' ')
      .trim();
    cues.push({ startMs, endMs, text });
  }

  return { cues, warnings };
}

/** Detect the format from content, falling back to null rather than guessing. */
export function detectFormat(input: string): SubtitleFormat | null {
  const head = normalise(input).trimStart().slice(0, 400);
  if (/^WEBVTT/.test(head)) return 'vtt';
  if (/\[Script Info\]|^Dialogue:/im.test(head)) return 'ass';
  if (/-->/.test(head)) return 'srt';
  return null;
}

export function parse(input: string, format?: SubtitleFormat): ParseResult {
  const resolved = format ?? detectFormat(input);
  switch (resolved) {
    case 'srt':
      return parseSrt(input);
    case 'vtt':
      return parseVtt(input);
    case 'ass':
      return parseAss(input);
    default:
      return { cues: [], warnings: ['Unrecognised subtitle format.'] };
  }
}

/* --------------------------------------------------------------- generating */

export function toSrt(cues: readonly Cue[]): string {
  return (
    cues
      .map((cue, i) =>
        [
          String(i + 1),
          `${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}`,
          cue.text,
        ].join('\n'),
      )
      .join('\n\n') + '\n'
  );
}

export function toVtt(cues: readonly Cue[]): string {
  const body = cues
    .map((cue) =>
      [
        `${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}`,
        cue.text,
      ].join('\n'),
    )
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,60,60,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

export function toAss(cues: readonly Cue[]): string {
  const events = cues
    .map(
      (cue) =>
        `Dialogue: 0,${formatAssTimestamp(cue.startMs)},${formatAssTimestamp(
          cue.endMs,
        )},Default,,0,0,0,,${cue.text.replace(/\n/g, '\\N')}`,
    )
    .join('\n');
  return `${ASS_HEADER}\n${events}\n`;
}

export function serialize(cues: readonly Cue[], format: SubtitleFormat): string {
  switch (format) {
    case 'srt':
      return toSrt(cues);
    case 'vtt':
      return toVtt(cues);
    case 'ass':
      return toAss(cues);
  }
}

/** Parse then re-serialize in one call. */
export function convert(
  input: string,
  to: SubtitleFormat,
  from?: SubtitleFormat,
): { readonly output: string; readonly warnings: readonly string[] } {
  const { cues, warnings } = parse(input, from);
  const extra =
    to === 'ass'
      ? [
          `ASS stores centiseconds: timings are rounded to the nearest ${ASS_ROUND_TRIP_LOSS_MS}ms.`,
        ]
      : [];
  return { output: serialize(cues, to), warnings: [...warnings, ...extra] };
}

/* ------------------------------------------------------------------ editing */

/** Shift every cue by `offsetMs`. Cues pushed before zero are clamped to zero. */
export function shift(cues: readonly Cue[], offsetMs: number): Cue[] {
  return cues.map((cue) => ({
    ...cue,
    startMs: clampMs(cue.startMs + offsetMs),
    endMs: clampMs(cue.endMs + offsetMs),
  }));
}

/**
 * Rescale timings by a factor — the fix for subtitles authored against a
 * different frame rate. 23.976 to 25 fps is `scale(cues, 23.976 / 25)`.
 */
export function scale(cues: readonly Cue[], factor: number): Cue[] | null {
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return cues.map((cue) => ({
    ...cue,
    startMs: clampMs(cue.startMs * factor),
    endMs: clampMs(cue.endMs * factor),
  }));
}

/** Sort by start time and clip any overlap so no two cues are on screen at once. */
export function deoverlap(cues: readonly Cue[], gapMs = 0): Cue[] {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  const out: Cue[] = [];
  for (const cue of sorted) {
    const previous = out[out.length - 1];
    if (previous && cue.startMs < previous.endMs + gapMs) {
      const trimmed = Math.max(previous.startMs, cue.startMs - gapMs);
      out[out.length - 1] = { ...previous, endMs: trimmed };
    }
    out.push(cue);
  }
  return out;
}
