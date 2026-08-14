# creator-tools

Zero-dependency TypeScript utilities for video and social creators: aspect-ratio
maths, tap tempo, subtitle parsing and conversion, platform frame sizes with
**sourced** safe areas, and encoding calculators.

No runtime dependencies. No network calls. Works in the browser, in Node, and in
a worker. Every number it returns is one you could check by hand — and where a
platform doesn't publish a number, it says so instead of inventing one.

```bash
npm install @prismposter/creator-tools
```

---

## Why this exists

Most of these calculations are scattered across blog posts that quote each other,
and a surprising number of the quoted figures are wrong. The one that started
this library: **every "TikTok safe area" pixel table on the open web is invented.**
TikTok publishes an overlay template, not a fixed inset — the occluded zone
varies with frame dimensions, caption length, and which ad formats are running.
There is no correct constant, so this library returns `null` for it and explains
why, rather than shipping a plausible-looking number.

That's the rule the whole package follows:

- **Derived numbers are derived.** A 9:16 frame at 1080 wide is 1920 tall because
  that's what the ratio says. Every size in `social-sizes` is asserted against its
  own declared ratio by the test suite.
- **Quoted numbers name their source.** Every safe area links the first-party page
  it was read from. `safeAreaSourceUrl(placement)` returns that URL.
- **Unknown is a value, not a blank.** A platform that publishes nothing gets an
  explicit `kind: 'unpublished'` with the reason attached.

---

## Modules

### `aspect-ratio`

Ratio arithmetic for frames about to be encoded. Handles non-integral cinema
ratios (2.39:1) the same way it handles 16:9.

```ts
import {
  simplifyRatio, cropToRatio, padToRatio, alignToBlock,
} from '@prismposter/creator-tools/aspect-ratio';

simplifyRatio({ width: 1920, height: 1080 });   // { w: 16, h: 9 }

cropToRatio({ width: 1920, height: 1080 }, { w: 9, h: 16 });
// { result: { width: 608, height: 1080 },
//   removed: { top: 0, right: 656, bottom: 0, left: 656 },
//   areaKept: 0.3167 }

// Codecs want even dimensions; H.264 chroma subsampling makes an odd
// width an encoder error or a silent rescale.
alignToBlock({ width: 1081, height: 607 });      // { width: 1082, height: 608 }
alignToBlock({ width: 1080, height: 1920 }, 16); // { width: 1088, height: 1920 }
```

An odd crop remainder always goes to the bottom/right edge. That's arbitrary, but
it's *consistent* — splitting it differently per call is how a batch of clips ends
up a pixel out of register with each other.

### `social-sizes`

Platform frames and safe areas, with sources.

```ts
import {
  getPlacement, frameSize, safeAreaPx, safeAreaBox, safeAreaSourceUrl,
} from '@prismposter/creator-tools/social-sizes';

const reels = getPlacement('instagram-reels')!;
frameSize(reels);           // { width: 1080, height: 1920 }
safeAreaPx(reels);          // { top: 269, bottom: 672, left: 65, right: 65 }
safeAreaBox(reels);         // { width: 950, height: 979 }
safeAreaSourceUrl(reels);   // Meta's Reels ads-guide page

const tiktok = getPlacement('tiktok-video')!;
safeAreaPx(tiktok);         // null — and that is the correct answer
tiktok.safeArea.reason;     // explains why no fixed table can be right
```

Meta publishes Reels and Stories as **14% top, 35% bottom, 6% each side**. On a
1080×1920 frame that's 269 / 672 / 65 px. The bottom third is not a typo.

`safeAreaPx` returning `null` is meaningful — surface it to your user as "this
platform publishes no fixed safe area". Don't substitute zeros, and don't borrow
another platform's numbers.

### `subtitles`

SRT, WebVTT, and ASS/SSA parsing, conversion, and timing edits. Everything routes
through one neutral `Cue` shape rather than converting format-to-format: six
formats would otherwise need thirty converters, each a place a rounding rule can
quietly differ.

```ts
import { convert, parse, shift, scale, deoverlap }
  from '@prismposter/creator-tools/subtitles';

const { output, warnings } = convert(srtText, 'vtt');

// Fix subtitles authored against a different frame rate.
scale(parse(srtText).cues, 23.976 / 25);

// Nudge everything 500ms later; cues pushed before zero clamp to zero.
shift(cues, 500);

// Clip overlaps so only one cue is ever on screen.
deoverlap(cues);
```

Parsing is tolerant: a malformed block produces a warning and is skipped, rather
than costing you the other 899 cues in the file. UTF-8 BOMs and CRLF endings are
handled. VTT `NOTE`/`STYLE` blocks and inline tags (`<v Roger>`, `<i>`) are
stripped; ASS override blocks (`{\an8}`) are too.

ASS stores centiseconds, so an ASS round-trip is lossy below 10 ms. `convert()`
tells you so in `warnings` rather than letting you discover it later.

### `tempo`

Tap tempo and the beat arithmetic an edit timeline needs.

```ts
import { estimateTempo, beatMs, noteMs, beatGrid, snapToBeat }
  from '@prismposter/creator-tools/tempo';

estimateTempo(tapTimestamps);
// { bpm: 128.02, taps: 16, spreadMs: 8.4, discarded: 1 }

beatMs(120);                              // 500
noteMs(120, 'quarter', { triplet: true }); // 333.333
beatGrid(120, 10_000);                     // [0, 500, 1000, … 10000]
snapToBeat(480, 120);                      // { timeMs: 500, deltaMs: 20 }
```

The estimator takes the **median** of a trailing window, not the mean. A tap
sequence has two failure modes a mean handles badly: the first taps run late while
the user finds the beat, and one missed tap creates an interval at roughly double
the true period. Outliers are discarded against the median, because a mean would
already have been dragged far enough to keep the bad interval inside tolerance.

`spreadMs` tells you how much to trust the result — under ~20 ms is a steady
tapper, over ~60 ms means the estimate is soft. `beatGrid` computes each position
from its index rather than accumulating, so a long sequence cannot drift.

### `encoding`

File size, bitrate, timecode, and frame counts.

```ts
import { fileSizeBytes, targetBitrateKbps, bitsPerPixel, toDropFrame }
  from '@prismposter/creator-tools/encoding';

fileSizeBytes(60, 8_000);          // 60_000_000 bytes
targetBitrateKbps(120, 50_000_000); // kbps to hit a 50 MB cap
bitsPerPixel(1920, 1080, 30, 8_000); // 0.1286
toDropFrame(1_800, 29.97);           // '00:01:00;02'
```

**Unit convention, stated once:** bitrates are **decimal** (1 Mbps = 1,000,000
bits/s, as every encoder and platform spec means it) and file sizes are **binary**
(1 MiB = 1,048,576 bytes, as every OS reports it). Mixing the two is why online
calculators disagree by about 5%. `formatBytesBinary` and `formatBytesDecimal`
are separate functions so the choice is always explicit.

Drop-frame timecode skips *labels*, never frames: numbers 00 and 01 are omitted at
the start of each minute except every tenth. That's what keeps 29.97 timecode
matching wall clock, which non-drop drifts from by ~3.6 s per hour.

---

## Design rules

1. **Pure functions, no side effects, no I/O.** Everything is synchronous and
   deterministic.
2. **Invalid input returns `null`, it does not throw.** These functions sit behind
   text inputs where a half-typed value is normal, not exceptional.
3. **Rounding happens once, at the boundary.** Sizes are whole pixels because
   that's what an encoder takes.
4. **`null` means "no answer exists"**, and is always distinguishable from zero.

## Development

```bash
npm install
npm test          # 98 tests
npm run typecheck
npm run build
```

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The bar for a new
constant is a first-party source; the bar for a new function is a test that would
fail without it.

## Related

These utilities cover the same ground as the free browser tools at
[PrismPoster](https://www.prismposter.com) — an
[aspect ratio calculator](https://www.prismposter.com/tools/aspect-ratio-calculator),
[BPM tapper](https://www.prismposter.com/tools/bpm-tapper),
[subtitle converter](https://www.prismposter.com/tools/subtitle-converter),
[social media size reference](https://www.prismposter.com/tools/social-media-sizes),
and [video calculator](https://www.prismposter.com/tools/video-calculator),
all free and browser-only.

## License

MIT © [PrismLabs OÜ](https://www.prismposter.com)
