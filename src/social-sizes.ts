/**
 * Platform frame sizes and safe areas.
 *
 * Two kinds of number live here and they are deliberately not mixed:
 *
 * 1. **Render targets are derived, not quoted.** A 9:16 delivery at 1080 wide is
 *    1920 tall because that is what the ratio says. Every size below is asserted
 *    against its own ratio by the test suite. These are what we recommend
 *    rendering, not a platform-published maximum.
 * 2. **Safe areas are quoted, and only from a first-party source**, which each
 *    entry names. Where a platform does not publish one, the entry says so *with
 *    the reason* — never a blank cell, and never a figure borrowed from a blog.
 *    An empty cell reads as "we did not check". A stated non-publication is the
 *    research worth citing.
 *
 * The single most repeated wrong number on the open web is a fixed TikTok inset
 * table. TikTok's own ad spec says the zone depends on the dimensions, caption
 * length, and which formats are in use, and ships an overlay template instead of
 * a number — so no fixed table can be right, and this module refuses to invent
 * one. If you came here looking for TikTok's safe-area pixels, the honest answer
 * is that they do not exist as a constant.
 */

import {
  heightForWidth,
  type EdgeInset,
  type Ratio,
  type Size,
} from './aspect-ratio.js';

/** First-party pages the safe-area figures are read from. */
export const SAFE_AREA_SOURCES = {
  metaReels:
    'https://www.facebook.com/business/ads-guide/update/video/instagram-reels',
  metaStory:
    'https://www.facebook.com/business/ads-guide/update/image/instagram-story',
  tiktokInFeed: 'https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads',
  youtubeBanner: 'https://support.google.com/youtube/answer/2972003',
} as const;

export type SafeAreaSourceId = keyof typeof SAFE_AREA_SOURCES;

/**
 * A safe area expressed the way the platform publishes it.
 *
 * Meta publishes percentages, so percentages are what is stored. Converting to
 * pixels is `safeAreaPx`'s job, and depends on the frame it is asked about.
 */
export interface PublishedSafeArea {
  readonly kind: 'published';
  readonly topPct: number;
  readonly bottomPct: number;
  readonly sidePct: number;
  readonly sourceId: SafeAreaSourceId;
}

/** The platform states no fixed inset exists. */
export interface UnpublishedSafeArea {
  readonly kind: 'unpublished';
  readonly reason: string;
  readonly sourceId: SafeAreaSourceId;
}

/** A still frame with no player chrome over it — nothing to keep clear of. */
export interface NoOverlaySafeArea {
  readonly kind: 'noOverlay';
}

/** Published as a fixed rectangle rather than as insets. */
export interface RegionSafeArea {
  readonly kind: 'region';
  readonly region: Size;
  readonly sourceId: SafeAreaSourceId;
}

export type SafeArea =
  | PublishedSafeArea
  | UnpublishedSafeArea
  | NoOverlaySafeArea
  | RegionSafeArea;

/**
 * Instagram Reels and Stories, as Meta publishes it: 14% top, 35% bottom, 6%
 * each side. On a 1080x1920 frame that is 269 / 672 / 65 px.
 *
 * The bottom third is not a typo. Facebook Stories *video* prints its own pixel
 * figures ("roughly 14% (250 pixels) top and 20% (340 pixels) bottom") that do
 * not agree with Meta's own percentages, so this cites the Instagram page and
 * uses the percentages.
 */
const META_VERTICAL: PublishedSafeArea = {
  kind: 'published',
  topPct: 0.14,
  bottomPct: 0.35,
  sidePct: 0.06,
  sourceId: 'metaReels',
};

const META_STORY: PublishedSafeArea = { ...META_VERTICAL, sourceId: 'metaStory' };

const TIKTOK_VIDEO: UnpublishedSafeArea = {
  kind: 'unpublished',
  reason:
    'TikTok publishes an overlay template rather than fixed insets: the occluded zone varies with frame dimensions, caption length, and which ad formats are in use. Any fixed pixel table for TikTok is wrong by construction.',
  sourceId: 'tiktokInFeed',
};

const NO_OVERLAY: NoOverlaySafeArea = { kind: 'noOverlay' };

export type PlatformId =
  | 'instagram'
  | 'tiktok'
  | 'youtube'
  | 'facebook'
  | 'linkedin'
  | 'x';

export type PlacementKind = 'video' | 'image';

export interface Placement {
  readonly id: string;
  readonly platform: PlatformId;
  readonly label: string;
  readonly kind: PlacementKind;
  readonly ratio: Ratio;
  /** Recommended render width in pixels; height is derived from `ratio`. */
  readonly renderWidth: number;
  readonly safeArea: SafeArea;
}

const V916: Ratio = { w: 9, h: 16 };
const H169: Ratio = { w: 16, h: 9 };
const SQUARE: Ratio = { w: 1, h: 1 };
const P45: Ratio = { w: 4, h: 5 };

export const PLACEMENTS: readonly Placement[] = [
  {
    id: 'instagram-reels',
    platform: 'instagram',
    label: 'Instagram Reels',
    kind: 'video',
    ratio: V916,
    renderWidth: 1080,
    safeArea: META_VERTICAL,
  },
  {
    id: 'instagram-story',
    platform: 'instagram',
    label: 'Instagram Story',
    kind: 'image',
    ratio: V916,
    renderWidth: 1080,
    safeArea: META_STORY,
  },
  {
    id: 'instagram-feed-portrait',
    platform: 'instagram',
    label: 'Instagram feed (portrait)',
    kind: 'image',
    ratio: P45,
    renderWidth: 1080,
    safeArea: NO_OVERLAY,
  },
  {
    id: 'instagram-feed-square',
    platform: 'instagram',
    label: 'Instagram feed (square)',
    kind: 'image',
    ratio: SQUARE,
    renderWidth: 1080,
    safeArea: NO_OVERLAY,
  },
  {
    id: 'tiktok-video',
    platform: 'tiktok',
    label: 'TikTok in-feed video',
    kind: 'video',
    ratio: V916,
    renderWidth: 1080,
    safeArea: TIKTOK_VIDEO,
  },
  {
    id: 'youtube-shorts',
    platform: 'youtube',
    label: 'YouTube Shorts',
    kind: 'video',
    ratio: V916,
    renderWidth: 1080,
    safeArea: NO_OVERLAY,
  },
  {
    id: 'youtube-video',
    platform: 'youtube',
    label: 'YouTube video',
    kind: 'video',
    ratio: H169,
    renderWidth: 1920,
    safeArea: NO_OVERLAY,
  },
  {
    id: 'youtube-channel-banner',
    platform: 'youtube',
    label: 'YouTube channel banner',
    kind: 'image',
    ratio: { w: 16, h: 9 },
    renderWidth: 2560,
    safeArea: {
      kind: 'region',
      // YouTube publishes the always-visible centre region explicitly.
      region: { width: 1546, height: 423 },
      sourceId: 'youtubeBanner',
    },
  },
  {
    id: 'facebook-reels',
    platform: 'facebook',
    label: 'Facebook Reels',
    kind: 'video',
    ratio: V916,
    renderWidth: 1080,
    safeArea: META_VERTICAL,
  },
  {
    id: 'facebook-feed',
    platform: 'facebook',
    label: 'Facebook feed',
    kind: 'image',
    ratio: P45,
    renderWidth: 1080,
    safeArea: NO_OVERLAY,
  },
  {
    id: 'linkedin-feed',
    platform: 'linkedin',
    label: 'LinkedIn feed',
    kind: 'image',
    ratio: SQUARE,
    renderWidth: 1200,
    safeArea: NO_OVERLAY,
  },
  {
    id: 'linkedin-video',
    platform: 'linkedin',
    label: 'LinkedIn video',
    kind: 'video',
    ratio: H169,
    renderWidth: 1920,
    safeArea: NO_OVERLAY,
  },
  {
    id: 'x-feed-image',
    platform: 'x',
    label: 'X feed image',
    kind: 'image',
    ratio: H169,
    renderWidth: 1600,
    safeArea: NO_OVERLAY,
  },
  {
    id: 'x-video',
    platform: 'x',
    label: 'X video',
    kind: 'video',
    ratio: H169,
    renderWidth: 1920,
    safeArea: NO_OVERLAY,
  },
] as const;

export function getPlacement(id: string): Placement | null {
  return PLACEMENTS.find((p) => p.id === id) ?? null;
}

export function placementsFor(platform: PlatformId): readonly Placement[] {
  return PLACEMENTS.filter((p) => p.platform === platform);
}

/** The recommended render size, derived from the placement's own ratio. */
export function frameSize(placement: Placement): Size | null {
  const height = heightForWidth(placement.renderWidth, placement.ratio);
  return height === null ? null : { width: placement.renderWidth, height };
}

/**
 * Safe-area insets in pixels for a placement, or null when the platform does not
 * publish a fixed inset.
 *
 * A null here is meaningful and should be surfaced to the user as "this platform
 * publishes no fixed safe area" — do not silently substitute zeros, and do not
 * fall back to another platform's numbers.
 */
export function safeAreaPx(placement: Placement): EdgeInset | null {
  const size = frameSize(placement);
  if (!size) return null;
  const area = placement.safeArea;

  switch (area.kind) {
    case 'published':
      return {
        top: Math.round(size.height * area.topPct),
        bottom: Math.round(size.height * area.bottomPct),
        left: Math.round(size.width * area.sidePct),
        right: Math.round(size.width * area.sidePct),
      };
    case 'region': {
      // Take the floor on one edge and the remainder on the other. Rounding
      // both independently loses a pixel on an odd difference, which would
      // make the resulting box smaller than the region the platform published.
      const extraX = size.width - area.region.width;
      const extraY = size.height - area.region.height;
      const left = Math.floor(extraX / 2);
      const top = Math.floor(extraY / 2);
      return { top, bottom: extraY - top, left, right: extraX - left };
    }
    case 'noOverlay':
      return { top: 0, right: 0, bottom: 0, left: 0 };
    case 'unpublished':
      return null;
  }
}

/** The rectangle left inside the safe area, or null if none is published. */
export function safeAreaBox(placement: Placement): Size | null {
  const size = frameSize(placement);
  const inset = safeAreaPx(placement);
  if (!size || !inset) return null;
  const width = size.width - inset.left - inset.right;
  const height = size.height - inset.top - inset.bottom;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The first-party URL a placement's safe area was read from, if any. */
export function safeAreaSourceUrl(placement: Placement): string | null {
  const area = placement.safeArea;
  return 'sourceId' in area ? SAFE_AREA_SOURCES[area.sourceId] : null;
}
