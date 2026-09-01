export * from './aspect-ratio.js';
export * from './encoding.js';
export * from './social-sizes.js';
export * from './tempo.js';
export * from './palette.js';
export * from './provenance.js';
export * from './image-metadata.js';

// Subtitles export a `parse`/`convert`/`scale` that would collide with nothing
// today, but the namespace keeps the barrel stable if a second parser is ever
// added. Both spellings work: `import { subtitles }` or the deep path
// `@prismposter/creator-tools/subtitles`.
export * as subtitles from './subtitles.js';
export type { Cue, ParseResult, SubtitleFormat } from './subtitles.js';

// GIF is namespaced for the same reason: `encodeGif` is unambiguous, but
// `indexFrame` and `frameTimes` are the kind of names a future module could
// reasonably want too.
export * as gif from './gif.js';
export type { GifFrame, GifImage, Centiseconds } from './gif.js';
