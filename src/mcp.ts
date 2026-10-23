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
  padToRatio,
  simplifyRatio,
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
import { parse, serialize, shift } from './subtitles.js';
import { beatMs, estimateTempo } from './tempo.js';

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
  version: '0.3.0',
  homepage: 'https://www.prismposter.com/tools',
} as const;

export const MCP_TOOLS = [
  {
    name: 'get_social_media_placement',
    description:
      'Get exact frame dimensions, aspect ratio, first-party safe-area insets (px), usable box, and official documentation URL for a social media placement (e.g. instagram-reels, tiktok-video, youtube-shorts). Optionally pass sourceWidth and sourceHeight to get crop and letterbox plans.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Placement ID (e.g. instagram-reels, instagram-story, instagram-feed-portrait, tiktok-video, youtube-shorts, youtube-video, youtube-channel-banner, linkedin-video, x-video, facebook-reels).',
        },
        sourceWidth: {
          type: 'number',
          description: 'Optional source frame width in pixels to calculate crop/pad fit.',
        },
        sourceHeight: {
          type: 'number',
          description: 'Optional source frame height in pixels to calculate crop/pad fit.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_social_media_placements',
    description:
      'List all social media video and image placements with dimensions, aspect ratios, safe-area pixel insets, and first-party source URLs. Optionally filter by platform.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['instagram', 'tiktok', 'youtube', 'linkedin', 'x', 'facebook'],
          description: 'Optional platform filter.',
        },
      },
    },
  },
  {
    name: 'calculate_aspect_ratio',
    description:
      'Simplify pixel dimensions to their aspect ratio, align to codec macroblocks, and optionally compute centre-crop and letterbox/pad plans for a target ratio.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Frame width in pixels.' },
        height: { type: 'number', description: 'Frame height in pixels.' },
        targetRatioW: { type: 'number', description: 'Optional target aspect ratio width term (e.g. 9).' },
        targetRatioH: { type: 'number', description: 'Optional target aspect ratio height term (e.g. 16).' },
        blockSize: { type: 'number', description: 'Optional codec block alignment (default 2).' },
      },
      required: ['width', 'height'],
    },
  },
  {
    name: 'estimate_video_bitrate',
    description:
      'Calculate encoded video file size (bytes, MiB, MB) from duration and bitrate, target bitrate for a file-size cap, and bits-per-pixel density.',
    inputSchema: {
      type: 'object',
      properties: {
        durationSec: { type: 'number', description: 'Clip duration in seconds.' },
        totalKbps: { type: 'number', description: 'Total bitrate (video + audio) in kbps (decimal).' },
        targetBytes: { type: 'number', description: 'Optional file-size cap in bytes to compute max kbps.' },
        widthPx: { type: 'number', description: 'Optional frame width in pixels for bits-per-pixel.' },
        heightPx: { type: 'number', description: 'Optional frame height in pixels for bits-per-pixel.' },
        fps: { type: 'number', description: 'Optional frame rate for bits-per-pixel.' },
      },
      required: ['durationSec'],
    },
  },
  {
    name: 'convert_subtitles',
    description:
      'Parse and convert subtitle files between SRT, WebVTT (vtt), and SubStation Alpha (ass), with optional timing offset in milliseconds.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Raw subtitle file content (SRT, VTT, or ASS).' },
        toFormat: {
          type: 'string',
          enum: ['srt', 'vtt', 'ass'],
          description: 'Target subtitle format.',
        },
        shiftMs: {
          type: 'number',
          description: 'Optional timing offset in milliseconds (positive delays, negative advances).',
        },
      },
      required: ['input', 'toFormat'],
    },
  },
  {
    name: 'estimate_tempo',
    description:
      'Estimate BPM from tap timestamps in milliseconds, or compute beat duration in ms for a known BPM.',
    inputSchema: {
      type: 'object',
      properties: {
        timestampsMs: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional list of monotonic tap timestamps in milliseconds.',
        },
        bpm: {
          type: 'number',
          description: 'Optional known BPM to calculate quarter-note beat duration in ms.',
        },
      },
    },
  },
] as const;

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

function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'get_social_media_placement': {
      const id = typeof args.id === 'string' ? args.id : '';
      const placement = getPlacement(id);
      if (!placement) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Unknown placement "${id}". Available IDs: ${PLACEMENTS.map((p) => p.id).join(', ')}`,
            },
          ],
        };
      }
      const sw = typeof args.sourceWidth === 'number' ? args.sourceWidth : null;
      const sh = typeof args.sourceHeight === 'number' ? args.sourceHeight : null;
      const fit =
        sw !== null && sh !== null
          ? {
              crop: cropToRatio({ width: sw, height: sh }, placement.ratio),
              pad: padToRatio({ width: sw, height: sh }, placement.ratio),
            }
          : null;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ...formatPlacementSummary(placement),
                ...(fit ? { fit } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case 'list_social_media_placements': {
      const platform = typeof args.platform === 'string' ? (args.platform as PlatformId) : null;
      const list = platform ? placementsFor(platform) : PLACEMENTS;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: list.length,
                canonicalDatasetUrl: 'https://www.prismposter.com/tools/social-media-sizes',
                placements: list.map(formatPlacementSummary),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case 'calculate_aspect_ratio': {
      const width = Number(args.width);
      const height = Number(args.height);
      const block = typeof args.blockSize === 'number' ? args.blockSize : 2;
      const size = { width, height };
      const ratio = simplifyRatio(size);
      const aligned = alignToBlock(size, block);
      const targetW = typeof args.targetRatioW === 'number' ? args.targetRatioW : null;
      const targetH = typeof args.targetRatioH === 'number' ? args.targetRatioH : null;
      const targetRatio =
        targetW !== null && targetH !== null ? { w: targetW, h: targetH } : null;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                input: size,
                ratio,
                formattedRatio: ratio ? formatRatio(ratio) : null,
                alignedToBlock: aligned,
                cropPlan: targetRatio ? cropToRatio(size, targetRatio) : null,
                padPlan: targetRatio ? padToRatio(size, targetRatio) : null,
                referenceToolUrl: 'https://www.prismposter.com/tools/aspect-ratio-calculator',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case 'estimate_video_bitrate': {
      const durationSec = Number(args.durationSec);
      const totalKbps = typeof args.totalKbps === 'number' ? args.totalKbps : null;
      const targetBytes = typeof args.targetBytes === 'number' ? args.targetBytes : null;
      const widthPx = typeof args.widthPx === 'number' ? args.widthPx : null;
      const heightPx = typeof args.heightPx === 'number' ? args.heightPx : null;
      const fps = typeof args.fps === 'number' ? args.fps : null;

      const bytes = totalKbps !== null ? fileSizeBytes(durationSec, totalKbps) : null;
      const maxKbps = targetBytes !== null ? targetBitrateKbps(durationSec, targetBytes) : null;
      const bpp =
        widthPx !== null && heightPx !== null && fps !== null && totalKbps !== null
          ? bitsPerPixel(widthPx, heightPx, fps, totalKbps)
          : null;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                durationSec,
                estimatedBytes: bytes,
                formattedBinary: bytes !== null ? formatBytesBinary(bytes) : null,
                formattedDecimal: bytes !== null ? formatBytesDecimal(bytes) : null,
                targetBitrateKbps: maxKbps,
                bitsPerPixel: bpp,
                referenceToolUrl: 'https://www.prismposter.com/tools/video-bitrate-calculator',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case 'convert_subtitles': {
      const input = typeof args.input === 'string' ? args.input : '';
      const toFormat =
        args.toFormat === 'srt' || args.toFormat === 'vtt' || args.toFormat === 'ass'
          ? args.toFormat
          : 'vtt';
      const shiftMs = typeof args.shiftMs === 'number' ? args.shiftMs : 0;
      const parsed = parse(input);
      const cues = shiftMs !== 0 ? shift(parsed.cues, shiftMs) : parsed.cues;
      const output = serialize(cues, toFormat);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                toFormat,
                cueCount: cues.length,
                warnings: parsed.warnings,
                output,
                referenceToolUrl: 'https://www.prismposter.com/tools/subtitle-converter',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case 'estimate_tempo': {
      const timestamps = Array.isArray(args.timestampsMs)
        ? args.timestampsMs.filter((n): n is number => typeof n === 'number')
        : [];
      const estimate = timestamps.length >= 2 ? estimateTempo(timestamps) : null;
      const bpm = typeof args.bpm === 'number' ? args.bpm : (estimate?.bpm ?? null);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                estimate,
                bpm,
                quarterNoteMs: bpm !== null ? beatMs(bpm) : null,
                referenceToolUrl: 'https://www.prismposter.com/tools/bpm-tapper',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    default:
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
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
      const clientVersion =
        typeof req.params?.protocolVersion === 'string'
          ? req.params.protocolVersion
          : '2024-11-05';
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: clientVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: MCP_SERVER_INFO,
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
