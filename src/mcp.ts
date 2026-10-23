#!/usr/bin/env node
/**
 * Zero-dependency Model Context Protocol (MCP) stdio server for
 * `@prismposter/creator-tools`.
 *
 * Exposes deterministic social-media safe areas, aspect-ratio arithmetic,
 * bitrate/file-size calculators, subtitle format conversion, and tempo maths
 * over JSON-RPC 2.0 stdio so AI coding assistants and agents can query
 * first-party-sourced specs without hallucinating pixel dimensions.
 *
 * Interactive browser equivalents: https://www.prismposter.com/tools
 */

import {
  alignToBlock,
  cropToRatio,
  formatRatio,
  isValidRatio,
  isValidSize,
  MAX_DIMENSION,
  padToRatio,
  simplifyRatio,
  type Ratio,
  type Size,
} from './aspect-ratio.js';
import {
  bitsPerPixel,
  fileSizeBytes,
  formatBytesBinary,
  formatBytesDecimal,
  targetBitrateKbps,
} from './encoding.js';
import {
  frameSize,
  getPlacement,
  PLACEMENTS,
  placementsFor,
  safeAreaBox,
  safeAreaPx,
  safeAreaSourceUrl,
  type Placement,
  type PlatformId,
} from './social-sizes.js';
import {
  ASS_ROUND_TRIP_LOSS_MS,
  detectFormat,
  parse,
  serialize,
  shift,
  type SubtitleFormat,
} from './subtitles.js';
import { barMs, beatMs, estimateTempo, MAX_BPM, MIN_BPM, TAP_TIMEOUT_MS } from './tempo.js';

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

export const MCP_SERVER_INFO = {
  name: '@prismposter/creator-tools',
  title: 'PrismPoster Creator Tools',
  version: '0.4.0',
  homepage: 'https://www.prismposter.com/tools',
} as const;

/** Newest first; `initialize` answers with the client's version only if it is listed here. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const MCP_INSTRUCTIONS =
  'Deterministic calculators for video and social creators. Every tool is a pure local computation: no network calls, no state, no side effects, and the same input always returns the same output. Platform figures come from first-party documentation and carry their source URL; where a platform publishes no fixed safe area (TikTok), tools say so instead of inventing one.';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const PLACEMENT_IDS = PLACEMENTS.map((p) => p.id);
const PLATFORM_IDS = [...new Set(PLACEMENTS.map((p) => p.platform))];
const SUBTITLE_FORMATS = ['srt', 'vtt', 'ass'] as const;
const SAFE_AREA_KINDS = ['published', 'unpublished', 'noOverlay', 'region'] as const;

const sizeSchema = {
  type: 'object',
  properties: { width: { type: 'integer' }, height: { type: 'integer' } },
  required: ['width', 'height'],
} as const;
const nullableSize = { anyOf: [sizeSchema, { type: 'null' }] } as const;
const insetSchema = {
  type: 'object',
  properties: {
    top: { type: 'integer' },
    right: { type: 'integer' },
    bottom: { type: 'integer' },
    left: { type: 'integer' },
  },
  required: ['top', 'right', 'bottom', 'left'],
} as const;
const nullableInset = { anyOf: [insetSchema, { type: 'null' }] } as const;
const rectSchema = {
  type: 'object',
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
  },
  required: ['x', 'y', 'width', 'height'],
} as const;
const ratioSchema = {
  type: 'object',
  properties: { w: { type: 'number' }, h: { type: 'number' } },
  required: ['w', 'h'],
} as const;
const nullableString = { type: ['string', 'null'] } as const;
const nullableNumber = { type: ['number', 'null'] } as const;

const placementSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    platform: { type: 'string' },
    label: { type: 'string' },
    kind: { type: 'string', enum: ['video', 'image'] },
    ratio: nullableString,
    size: nullableSize,
    safeAreaKind: { type: 'string', enum: SAFE_AREA_KINDS },
    safeAreaInsetsPx: nullableInset,
    usableBoxPx: nullableSize,
    usableSharePct: nullableNumber,
    unpublishedReason: nullableString,
    firstPartySourceUrl: nullableString,
    referenceToolUrl: { type: 'string' },
  },
  required: [
    'id',
    'platform',
    'label',
    'kind',
    'ratio',
    'size',
    'safeAreaKind',
    'safeAreaInsetsPx',
    'usableBoxPx',
    'usableSharePct',
    'unpublishedReason',
    'firstPartySourceUrl',
    'referenceToolUrl',
  ],
} as const;

const cropPlanSchema = {
  anyOf: [
    {
      type: 'object',
      properties: { result: sizeSchema, removed: insetSchema, areaKept: { type: 'number' } },
      required: ['result', 'removed', 'areaKept'],
    },
    { type: 'null' },
  ],
} as const;
const padPlanSchema = {
  anyOf: [
    {
      type: 'object',
      properties: { result: sizeSchema, added: insetSchema, imageFraction: { type: 'number' } },
      required: ['result', 'added', 'imageFraction'],
    },
    { type: 'null' },
  ],
} as const;

export const MCP_TOOLS = [
  {
    name: 'get_social_media_placement',
    title: 'Get one social media placement spec',
    description:
      'Look up one social media placement by id and return its frame size, aspect ratio, first-party safe-area insets in px, usable box, and the official page the figures came from. Pass sourceWidth and sourceHeight together to also get the centre-crop and letterbox plan that fits your footage to this placement. Use this when you know the target placement; use list_social_media_placements to browse or compare placements, check_safe_area to test whether an element is clear of the platform UI, and calculate_aspect_ratio for a ratio that is not a platform placement. For TikTok the insets are null with a reason, because TikTok publishes no fixed safe area. Errors on an unknown id (the message lists valid ids) or on only one source dimension.',
    annotations: { title: 'Get one social media placement spec', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          enum: PLACEMENT_IDS,
          description: 'Placement id, e.g. instagram-reels, tiktok-video or youtube-shorts.',
        },
        sourceWidth: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_DIMENSION,
          description: 'Width of your source footage in px. Requires sourceHeight.',
        },
        sourceHeight: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_DIMENSION,
          description: 'Height of your source footage in px. Requires sourceWidth.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        ...placementSummarySchema.properties,
        fit: {
          anyOf: [
            {
              type: 'object',
              properties: { source: sizeSchema, crop: cropPlanSchema, pad: padPlanSchema },
              required: ['source', 'crop', 'pad'],
            },
            { type: 'null' },
          ],
        },
      },
      required: [...placementSummarySchema.required, 'fit'],
    },
  },
  {
    name: 'list_social_media_placements',
    title: 'List social media placement specs',
    description:
      "List every supported social media placement (or one platform's) with frame size, aspect ratio, safe-area insets in px, usable box and first-party source URL, in one response. Use this to browse, compare platforms, or find a placement id; use get_social_media_placement when you already know the id and also need a crop/letterbox plan for your footage. The list is a fixed built-in dataset returned whole, with no paging.",
    annotations: { title: 'List social media placement specs', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: PLATFORM_IDS,
          description: 'Only return placements for this platform. Omit for all platforms.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        platform: nullableString,
        canonicalDatasetUrl: { type: 'string' },
        placements: { type: 'array', items: placementSummarySchema },
      },
      required: ['count', 'platform', 'canonicalDatasetUrl', 'placements'],
    },
  },
  {
    name: 'check_safe_area',
    title: 'Check an element against a placement safe area',
    description:
      'Check whether a rectangle (a caption, logo or button, in px on the placement\'s own frame, origin top-left) stays inside the placement\'s published safe area, and by how many px it intrudes past each edge if not. Use this to validate a layout before export; use get_social_media_placement for the raw insets. Returns verdict "inside", "intrudes" or "unknown"; "unknown" means the platform publishes no fixed safe area (TikTok) and comes with the reason instead of a guess. Errors on an unknown placement id or a box with non-positive size.',
    annotations: { title: 'Check an element against a placement safe area', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        placementId: {
          type: 'string',
          enum: PLACEMENT_IDS,
          description: 'Placement id, e.g. instagram-reels.',
        },
        x: { type: 'integer', description: "Element's left edge in px from the frame's left edge." },
        y: { type: 'integer', description: "Element's top edge in px from the frame's top edge." },
        width: { type: 'integer', minimum: 1, description: 'Element width in px.' },
        height: { type: 'integer', minimum: 1, description: 'Element height in px.' },
      },
      required: ['placementId', 'x', 'y', 'width', 'height'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        placementId: { type: 'string' },
        frame: sizeSchema,
        box: rectSchema,
        verdict: { type: 'string', enum: ['inside', 'intrudes', 'unknown'] },
        withinFrame: { type: 'boolean' },
        safeAreaKind: { type: 'string', enum: SAFE_AREA_KINDS },
        safeRectPx: { anyOf: [rectSchema, { type: 'null' }] },
        intrusionPx: nullableInset,
        unpublishedReason: nullableString,
        firstPartySourceUrl: nullableString,
        referenceToolUrl: { type: 'string' },
      },
      required: [
        'placementId',
        'frame',
        'box',
        'verdict',
        'withinFrame',
        'safeAreaKind',
        'safeRectPx',
        'intrusionPx',
        'unpublishedReason',
        'firstPartySourceUrl',
        'referenceToolUrl',
      ],
    },
  },
  {
    name: 'calculate_aspect_ratio',
    title: 'Calculate aspect ratio and crop/pad plan',
    description:
      "Reduce any pixel size to its simplest aspect ratio (1920x1080 is 16:9), round it up to an even or codec-block multiple, and, given a target ratio, return the centre-crop and letterbox/pillarbox plans with the px removed or added per edge. Use this for arbitrary sizes and ratios (cinema 2.39:1, a client's 4:5); when the target is a named platform placement, use get_social_media_placement with sourceWidth/sourceHeight instead, which picks the right ratio for you. Errors on a non-integer or out-of-range size, or on only one of targetRatioW/targetRatioH.",
    annotations: { title: 'Calculate aspect ratio and crop/pad plan', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 1, maximum: MAX_DIMENSION, description: 'Frame width in px.' },
        height: { type: 'integer', minimum: 1, maximum: MAX_DIMENSION, description: 'Frame height in px.' },
        targetRatioW: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Width term of the ratio to crop or pad to, e.g. 9 for 9:16 or 2.39 for 2.39:1. Requires targetRatioH.',
        },
        targetRatioH: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Height term of the target ratio, e.g. 16 for 9:16. Requires targetRatioW.',
        },
        blockSize: {
          type: 'integer',
          minimum: 1,
          default: 2,
          description: 'Round dimensions up to a multiple of this: 2 for H.264 4:2:0, 16 for macroblock-aligned. Default 2.',
        },
      },
      required: ['width', 'height'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        input: sizeSchema,
        ratio: { anyOf: [ratioSchema, { type: 'null' }] },
        formattedRatio: nullableString,
        blockSize: { type: 'integer' },
        alignedToBlock: nullableSize,
        targetRatio: { anyOf: [ratioSchema, { type: 'null' }] },
        cropPlan: cropPlanSchema,
        padPlan: padPlanSchema,
        referenceToolUrl: { type: 'string' },
      },
      required: [
        'input',
        'ratio',
        'formattedRatio',
        'blockSize',
        'alignedToBlock',
        'targetRatio',
        'cropPlan',
        'padPlan',
        'referenceToolUrl',
      ],
    },
  },
  {
    name: 'estimate_video_bitrate',
    title: 'Estimate video file size and bitrate',
    description:
      'Video size and bitrate arithmetic for a clip of durationSec. Pass totalKbps to get the encoded file size (bytes, binary MiB and decimal MB); pass targetBytes to get the highest total bitrate that fits that size; add widthPx, heightPx and fps (with totalKbps) to get bits per pixel, a codec-independent check of whether the bitrate suits the resolution. Kbps is decimal (1 kbps = 1000 bit/s) and covers video plus audio. Use it to plan an export or hit an upload cap; it does not inspect or encode files. Errors when neither totalKbps nor targetBytes is given, or when only some of the bits-per-pixel inputs are.',
    annotations: { title: 'Estimate video file size and bitrate', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        durationSec: { type: 'number', exclusiveMinimum: 0, description: 'Clip length in seconds.' },
        totalKbps: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Combined video + audio bitrate in kbps. Needed for file size and bits per pixel.',
        },
        targetBytes: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'File-size cap in bytes (25 MB = 25000000) to solve for the maximum total kbps.',
        },
        widthPx: { type: 'integer', minimum: 1, description: 'Frame width in px, for bits per pixel.' },
        heightPx: { type: 'integer', minimum: 1, description: 'Frame height in px, for bits per pixel.' },
        fps: { type: 'number', exclusiveMinimum: 0, description: 'Frame rate, for bits per pixel.' },
      },
      required: ['durationSec'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        durationSec: { type: 'number' },
        totalKbps: nullableNumber,
        estimatedBytes: nullableNumber,
        formattedBinary: nullableString,
        formattedDecimal: nullableString,
        targetBytes: nullableNumber,
        targetBitrateKbps: nullableNumber,
        bitsPerPixel: nullableNumber,
        referenceToolUrl: { type: 'string' },
      },
      required: [
        'durationSec',
        'totalKbps',
        'estimatedBytes',
        'formattedBinary',
        'formattedDecimal',
        'targetBytes',
        'targetBitrateKbps',
        'bitsPerPixel',
        'referenceToolUrl',
      ],
    },
  },
  {
    name: 'convert_subtitles',
    title: 'Convert subtitles between SRT, VTT and ASS',
    description:
      'Convert subtitle text between SRT, WebVTT and ASS/SSA, optionally shifting every cue by shiftMs, and return the converted text with the cue count and any warnings. Pass the file contents, not a path. The input format is detected from the content unless fromFormat is given. Malformed blocks are skipped with a warning instead of failing the whole file; converting to ASS rounds timings to 10 ms. Errors when the format cannot be detected or no cue could be parsed.',
    annotations: { title: 'Convert subtitles between SRT, VTT and ASS', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', minLength: 1, description: 'The full subtitle file contents as text.' },
        toFormat: { type: 'string', enum: SUBTITLE_FORMATS, description: 'Format to convert to.' },
        fromFormat: {
          type: 'string',
          enum: SUBTITLE_FORMATS,
          description: 'Format of the input. Omit to detect it from the content.',
        },
        shiftMs: {
          type: 'integer',
          description: 'Move every cue by this many ms: positive is later, negative earlier. Cues pushed before 0 clamp to 0.',
        },
      },
      required: ['input', 'toFormat'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        fromFormat: { type: 'string', enum: SUBTITLE_FORMATS },
        toFormat: { type: 'string', enum: SUBTITLE_FORMATS },
        cueCount: { type: 'integer' },
        shiftMs: { type: 'integer' },
        warnings: { type: 'array', items: { type: 'string' } },
        output: { type: 'string' },
        referenceToolUrl: { type: 'string' },
      },
      required: ['fromFormat', 'toFormat', 'cueCount', 'shiftMs', 'warnings', 'output', 'referenceToolUrl'],
    },
  },
  {
    name: 'estimate_tempo',
    title: 'Estimate tempo from taps or a BPM',
    description:
      'Tempo arithmetic for editing to music: pass tap timestamps (ms) to estimate BPM, with a spread figure that shows how steady the taps were, or pass a known bpm to get the beat and 4/4 bar length in ms for cutting on the beat. It works on numbers you supply and does not analyse audio. Taps more than 2.5 s apart restart the count, and outlier intervals (a missed or doubled tap) are discarded. Errors when neither input is given, fewer than two usable taps remain, or bpm is outside 20-400.',
    annotations: { title: 'Estimate tempo from taps or a BPM', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        timestampsMs: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          description: 'Tap times in ms from a monotonic clock (performance.now()), in order.',
        },
        bpm: {
          type: 'number',
          minimum: MIN_BPM,
          maximum: MAX_BPM,
          description: 'Known tempo in beats per minute. Used instead of the estimate when both are given.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        estimate: {
          anyOf: [
            {
              type: 'object',
              properties: {
                bpm: { type: 'number' },
                taps: { type: 'integer' },
                spreadMs: { type: 'number' },
                discarded: { type: 'integer' },
              },
              required: ['bpm', 'taps', 'spreadMs', 'discarded'],
            },
            { type: 'null' },
          ],
        },
        bpm: { type: 'number' },
        quarterNoteMs: { type: 'number' },
        barMs4_4: { type: 'number' },
        referenceToolUrl: { type: 'string' },
      },
      required: ['estimate', 'bpm', 'quarterNoteMs', 'barMs4_4', 'referenceToolUrl'],
    },
  },
] as const;

/** A caller mistake the agent can fix; surfaced as an MCP tool error, not a protocol error. */
class ToolInputError extends Error {}

function formatPlacementSummary(p: Placement) {
  const size = frameSize(p);
  const box = safeAreaBox(p);
  const share =
    size && box
      ? Math.round(((box.width * box.height) / (size.width * size.height)) * 100)
      : null;
  return {
    id: p.id,
    platform: p.platform,
    label: p.label,
    kind: p.kind,
    ratio: formatRatio(p.ratio),
    size,
    safeAreaKind: p.safeArea.kind,
    safeAreaInsetsPx: safeAreaPx(p),
    usableBoxPx: box,
    usableSharePct: share,
    unpublishedReason: p.safeArea.kind === 'unpublished' ? p.safeArea.reason : null,
    firstPartySourceUrl: safeAreaSourceUrl(p),
    referenceToolUrl: 'https://www.prismposter.com/tools/social-media-sizes',
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function optionalNumber(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (!isNum(v)) throw new ToolInputError(`${key} must be a finite number.`);
  return v;
}

function requiredNumber(args: Record<string, unknown>, key: string): number {
  const v = optionalNumber(args, key);
  if (v === null) throw new ToolInputError(`${key} is required.`);
  return v;
}

function requirePlacement(id: unknown, key: string): Placement {
  const placement = typeof id === 'string' ? getPlacement(id) : null;
  if (!placement) {
    throw new ToolInputError(
      `Unknown ${key} "${String(id)}". Valid ids: ${PLACEMENT_IDS.join(', ')}. Call list_social_media_placements to compare them.`,
    );
  }
  return placement;
}

function requireSize(width: number, height: number, label: string): Size {
  const size = { width, height };
  if (!isValidSize(size)) {
    throw new ToolInputError(
      `${label} must be whole pixels between 1 and ${MAX_DIMENSION}; got ${width}x${height}.`,
    );
  }
  return size;
}

function runTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'get_social_media_placement': {
      const placement = requirePlacement(args.id, 'placement id');
      const sw = optionalNumber(args, 'sourceWidth');
      const sh = optionalNumber(args, 'sourceHeight');
      if ((sw === null) !== (sh === null)) {
        throw new ToolInputError('Pass sourceWidth and sourceHeight together, or neither.');
      }
      let fit = null;
      if (sw !== null && sh !== null) {
        const source = requireSize(sw, sh, 'sourceWidth/sourceHeight');
        fit = {
          source,
          crop: cropToRatio(source, placement.ratio),
          pad: padToRatio(source, placement.ratio),
        };
      }
      return { ...formatPlacementSummary(placement), fit };
    }

    case 'list_social_media_placements': {
      const platform = args.platform;
      if (platform !== undefined && !PLATFORM_IDS.includes(platform as PlatformId)) {
        throw new ToolInputError(`Unknown platform "${String(platform)}". Valid: ${PLATFORM_IDS.join(', ')}.`);
      }
      const list = platform ? placementsFor(platform as PlatformId) : PLACEMENTS;
      return {
        count: list.length,
        platform: (platform as string | undefined) ?? null,
        canonicalDatasetUrl: 'https://www.prismposter.com/tools/social-media-sizes',
        placements: list.map(formatPlacementSummary),
      };
    }

    case 'check_safe_area': {
      const placement = requirePlacement(args.placementId, 'placementId');
      const box = {
        x: requiredNumber(args, 'x'),
        y: requiredNumber(args, 'y'),
        width: requiredNumber(args, 'width'),
        height: requiredNumber(args, 'height'),
      };
      if (box.width <= 0 || box.height <= 0) {
        throw new ToolInputError('width and height must be greater than 0.');
      }
      const frame = frameSize(placement) as Size;
      const withinFrame =
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= frame.width &&
        box.y + box.height <= frame.height;
      const inset = safeAreaPx(placement);
      const base = {
        placementId: placement.id,
        frame,
        box,
        withinFrame,
        safeAreaKind: placement.safeArea.kind,
        unpublishedReason: placement.safeArea.kind === 'unpublished' ? placement.safeArea.reason : null,
        firstPartySourceUrl: safeAreaSourceUrl(placement),
        referenceToolUrl: 'https://www.prismposter.com/tools/social-media-sizes',
      };
      if (!inset) {
        return { ...base, verdict: 'unknown', safeRectPx: null, intrusionPx: null };
      }
      const safeRect = {
        x: inset.left,
        y: inset.top,
        width: frame.width - inset.left - inset.right,
        height: frame.height - inset.top - inset.bottom,
      };
      const intrusion = {
        top: Math.max(0, safeRect.y - box.y),
        right: Math.max(0, box.x + box.width - (safeRect.x + safeRect.width)),
        bottom: Math.max(0, box.y + box.height - (safeRect.y + safeRect.height)),
        left: Math.max(0, safeRect.x - box.x),
      };
      const intrudes = Object.values(intrusion).some((v) => v > 0);
      return {
        ...base,
        verdict: intrudes ? 'intrudes' : 'inside',
        safeRectPx: safeRect,
        intrusionPx: intrusion,
      };
    }

    case 'calculate_aspect_ratio': {
      const size = requireSize(requiredNumber(args, 'width'), requiredNumber(args, 'height'), 'width/height');
      const blockSize = optionalNumber(args, 'blockSize') ?? 2;
      if (!Number.isInteger(blockSize) || blockSize < 1) {
        throw new ToolInputError('blockSize must be a whole number of at least 1.');
      }
      const tw = optionalNumber(args, 'targetRatioW');
      const th = optionalNumber(args, 'targetRatioH');
      if ((tw === null) !== (th === null)) {
        throw new ToolInputError('Pass targetRatioW and targetRatioH together, or neither.');
      }
      let targetRatio: Ratio | null = null;
      if (tw !== null && th !== null) {
        targetRatio = { w: tw, h: th };
        if (!isValidRatio(targetRatio)) {
          throw new ToolInputError('targetRatioW and targetRatioH must be positive numbers up to 10000.');
        }
      }
      const ratio = simplifyRatio(size);
      return {
        input: size,
        ratio,
        formattedRatio: ratio ? formatRatio(ratio) : null,
        blockSize,
        alignedToBlock: alignToBlock(size, blockSize),
        targetRatio,
        cropPlan: targetRatio ? cropToRatio(size, targetRatio) : null,
        padPlan: targetRatio ? padToRatio(size, targetRatio) : null,
        referenceToolUrl: 'https://www.prismposter.com/tools/aspect-ratio-calculator',
      };
    }

    case 'estimate_video_bitrate': {
      const durationSec = requiredNumber(args, 'durationSec');
      if (durationSec <= 0) throw new ToolInputError('durationSec must be greater than 0.');
      const totalKbps = optionalNumber(args, 'totalKbps');
      const targetBytes = optionalNumber(args, 'targetBytes');
      const widthPx = optionalNumber(args, 'widthPx');
      const heightPx = optionalNumber(args, 'heightPx');
      const fps = optionalNumber(args, 'fps');
      if (totalKbps === null && targetBytes === null) {
        throw new ToolInputError('Pass totalKbps (to get the file size) or targetBytes (to get the max bitrate).');
      }
      const bppInputs = [widthPx, heightPx, fps].filter((v) => v !== null).length;
      if (bppInputs > 0 && (bppInputs < 3 || totalKbps === null)) {
        throw new ToolInputError('Bits per pixel needs widthPx, heightPx, fps and totalKbps together.');
      }
      const bytes = totalKbps !== null ? fileSizeBytes(durationSec, totalKbps) : null;
      return {
        durationSec,
        totalKbps,
        estimatedBytes: bytes,
        formattedBinary: bytes !== null ? formatBytesBinary(bytes) : null,
        formattedDecimal: bytes !== null ? formatBytesDecimal(bytes) : null,
        targetBytes,
        targetBitrateKbps: targetBytes !== null ? targetBitrateKbps(durationSec, targetBytes) : null,
        bitsPerPixel:
          bppInputs === 3 && totalKbps !== null
            ? bitsPerPixel(widthPx as number, heightPx as number, fps as number, totalKbps)
            : null,
        referenceToolUrl: 'https://www.prismposter.com/tools/video-bitrate-calculator',
      };
    }

    case 'convert_subtitles': {
      const input = typeof args.input === 'string' ? args.input : '';
      if (!input.trim()) throw new ToolInputError('input must be the subtitle file contents.');
      const isFormat = (v: unknown): v is SubtitleFormat =>
        typeof v === 'string' && (SUBTITLE_FORMATS as readonly string[]).includes(v);
      if (!isFormat(args.toFormat)) {
        throw new ToolInputError(`toFormat must be one of ${SUBTITLE_FORMATS.join(', ')}.`);
      }
      if (args.fromFormat !== undefined && !isFormat(args.fromFormat)) {
        throw new ToolInputError(`fromFormat must be one of ${SUBTITLE_FORMATS.join(', ')}.`);
      }
      const toFormat = args.toFormat;
      const fromFormat = isFormat(args.fromFormat) ? args.fromFormat : detectFormat(input);
      if (!fromFormat) {
        throw new ToolInputError('Could not detect the subtitle format. Pass fromFormat (srt, vtt or ass).');
      }
      const shiftMs = optionalNumber(args, 'shiftMs') ?? 0;
      if (!Number.isInteger(shiftMs)) throw new ToolInputError('shiftMs must be a whole number of ms.');
      const parsed = parse(input, fromFormat);
      if (parsed.cues.length === 0) {
        const detail = parsed.warnings.length ? ` ${parsed.warnings.join(' ')}` : '';
        throw new ToolInputError(`No cues could be parsed as ${fromFormat}.${detail}`);
      }
      const cues = shiftMs !== 0 ? shift(parsed.cues, shiftMs) : parsed.cues;
      const warnings =
        toFormat === 'ass'
          ? [
              ...parsed.warnings,
              `ASS stores centiseconds: timings are rounded to the nearest ${ASS_ROUND_TRIP_LOSS_MS}ms.`,
            ]
          : [...parsed.warnings];
      return {
        fromFormat,
        toFormat,
        cueCount: cues.length,
        shiftMs,
        warnings,
        output: serialize(cues, toFormat),
        referenceToolUrl: 'https://www.prismposter.com/tools/subtitle-converter',
      };
    }

    case 'estimate_tempo': {
      const raw = args.timestampsMs;
      if (raw !== undefined && (!Array.isArray(raw) || !raw.every(isNum))) {
        throw new ToolInputError('timestampsMs must be an array of numbers.');
      }
      const knownBpm = optionalNumber(args, 'bpm');
      if (raw === undefined && knownBpm === null) {
        throw new ToolInputError('Pass timestampsMs (to estimate BPM) or bpm (to get beat and bar lengths).');
      }
      const estimate = Array.isArray(raw) ? estimateTempo(raw as number[]) : null;
      if (Array.isArray(raw) && !estimate && knownBpm === null) {
        throw new ToolInputError(
          `Need at least two taps under ${TAP_TIMEOUT_MS} ms apart, in order, at a tempo between ${MIN_BPM} and ${MAX_BPM} BPM.`,
        );
      }
      const bpm = knownBpm ?? (estimate as { bpm: number }).bpm;
      const quarterNoteMs = beatMs(bpm);
      const bar = barMs(bpm, 4);
      if (quarterNoteMs === null || bar === null) {
        throw new ToolInputError(`bpm must be between ${MIN_BPM} and ${MAX_BPM}.`);
      }
      return {
        estimate,
        bpm,
        quarterNoteMs,
        barMs4_4: bar,
        referenceToolUrl: 'https://www.prismposter.com/tools/bpm-tapper',
      };
    }

    default:
      throw new ToolInputError(`Unknown tool "${name}". Call tools/list for the available tools.`);
  }
}

function callTool(name: string, args: Record<string, unknown>) {
  try {
    const data = runTool(name, args);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  } catch (err) {
    if (!(err instanceof ToolInputError)) throw err;
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
}

/**
 * Pure JSON-RPC 2.0 handler for MCP messages. Returns `null` for notifications
 * (requests without an `id`).
 */
export function handleMcpRequest(req: JsonRpcRequest): JsonRpcResponse | null {
  if (req.id === undefined) {
    return null;
  }

  switch (req.method) {
    case 'initialize': {
      const requested = req.params?.protocolVersion;
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested)
        ? (requested as string)
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        },
      };
    }

    case 'ping':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {},
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: MCP_TOOLS,
        },
      };

    case 'tools/call': {
      const name = typeof req.params?.name === 'string' ? req.params.name : '';
      const args =
        req.params?.arguments && typeof req.params.arguments === 'object'
          ? (req.params.arguments as Record<string, unknown>)
          : {};
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: callTool(name, args),
      };
    }

    default:
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: -32601,
          message: `Method not found: ${req.method}`,
        },
      };
  }
}

/** Start the stdio JSON-RPC server when invoked as a CLI binary. */
export async function startMcpStdioServer(): Promise<void> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcRequest;
      const response = handleMcpRequest(parsed);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        })}\n`,
      );
    }
  });
}

// Auto-start when executed directly via `npx @prismposter/creator-tools`
const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('mcp.js') ||
    process.argv[1].endsWith('prismposter-creator-tools') ||
    process.argv[1].endsWith('prismposter-mcp'));

if (isDirectExecution) {
  void startMcpStdioServer();
}
