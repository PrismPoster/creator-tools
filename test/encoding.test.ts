import { describe, expect, it } from 'vitest';
import {
  bitsPerPixel,
  fileSizeBytes,
  formatBytesBinary,
  formatBytesDecimal,
  frameCount,
  framesToSeconds,
  parseTimecode,
  splitBitrate,
  targetBitrateKbps,
  toDropFrame,
  toTimecode,
} from '../src/encoding.js';

describe('fileSizeBytes', () => {
  it('uses decimal bitrate units, as encoders do', () => {
    // 8000 kbps for 60s = 8,000,000 bits/s * 60 / 8 = 60,000,000 bytes.
    expect(fileSizeBytes(60, 8_000)).toBe(60_000_000);
  });

  it('rejects a zero duration', () => {
    expect(fileSizeBytes(0, 8_000)).toBeNull();
  });
});

describe('targetBitrateKbps', () => {
  it('inverts fileSizeBytes', () => {
    const bytes = fileSizeBytes(120, 6_000) as number;
    expect(targetBitrateKbps(120, bytes)).toBe(6_000);
  });
});

describe('splitBitrate', () => {
  it('subtracts the audio track from the budget', () => {
    expect(splitBitrate(8_000)).toEqual({ videoKbps: 7_872, audioKbps: 128 });
  });

  it('returns null when audio alone exceeds the budget', () => {
    expect(splitBitrate(96, 128)).toBeNull();
  });
});

describe('bitsPerPixel', () => {
  it('computes density for a 1080p delivery', () => {
    const bpp = bitsPerPixel(1920, 1080, 30, 8_000) as number;
    expect(bpp).toBeGreaterThan(0.12);
    expect(bpp).toBeLessThan(0.13);
  });

  it('falls as resolution rises at a fixed bitrate', () => {
    const hd = bitsPerPixel(1920, 1080, 30, 8_000) as number;
    const uhd = bitsPerPixel(3840, 2160, 30, 8_000) as number;
    expect(uhd).toBeLessThan(hd);
  });
});

describe('byte formatting', () => {
  it('reports binary units the way an OS does', () => {
    expect(formatBytesBinary(1_048_576)).toBe('1.00 MiB');
  });

  it('reports decimal units the way a platform limit does', () => {
    expect(formatBytesDecimal(1_000_000)).toBe('1.00 MB');
  });

  it('shows the ~5% divergence that trips people up', () => {
    expect(formatBytesBinary(1_000_000)).toBe('976.56 KiB');
  });

  it('leaves raw bytes unscaled', () => {
    expect(formatBytesBinary(512)).toBe('512 B');
  });
});

describe('frames', () => {
  it('truncates a partial trailing frame', () => {
    expect(frameCount(1.999, 30)).toBe(59);
  });

  it('avoids a float-precision off-by-one at exact boundaries', () => {
    expect(frameCount(2, 30)).toBe(60);
    expect(frameCount(0.1, 30)).toBe(3);
  });

  it('converts back to seconds', () => {
    expect(framesToSeconds(60, 30)).toBe(2);
  });
});

describe('timecode', () => {
  it('formats non-drop timecode', () => {
    expect(toTimecode(90_000, 25)).toBe('01:00:00:00');
  });

  it('round-trips through parseTimecode', () => {
    const frames = 123_456;
    const tc = toTimecode(frames, 25) as string;
    expect(parseTimecode(tc, 25)).toBe(frames);
  });

  it('rejects a frame number the rate cannot hold', () => {
    expect(parseTimecode('00:00:00:30', 25)).toBeNull();
  });
});

describe('drop-frame timecode', () => {
  it('is defined only for 29.97 and 59.94', () => {
    expect(toDropFrame(100, 25)).toBeNull();
    expect(toDropFrame(100, 29.97)).not.toBeNull();
  });

  it('skips labels 00 and 01 at the first minute', () => {
    // Frame 1800 is one minute of 30fps counting; drop-frame labels it 00:01:00;02.
    expect(toDropFrame(1_800, 29.97)).toBe('00:01:00;02');
  });

  it('does not skip at the tenth minute', () => {
    expect(toDropFrame(17_982, 29.97)).toBe('00:10:00;00');
  });
});
