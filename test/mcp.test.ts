import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  handleMcpRequest,
  MCP_INSTRUCTIONS,
  MCP_SERVER_INFO,
  MCP_TOOLS,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION,
} from '../src/mcp.js';

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

const ajv = new Ajv({ allowUnionTypes: true });

function call(name: string, args: Record<string, unknown>): ToolResult {
  const res = handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return res?.result as ToolResult;
}

/** A successful call whose structuredContent matches the tool's declared outputSchema. */
function ok(name: string, args: Record<string, unknown>): Record<string, any> {
  const result = call(name, args);
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  const tool = MCP_TOOLS.find((t) => t.name === name)!;
  const validate = ajv.compile(tool.outputSchema);
  expect(validate(result.structuredContent), JSON.stringify(validate.errors)).toBe(true);
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}

function fails(name: string, args: Record<string, unknown>): string {
  const result = call(name, args);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  return result.content[0]!.text;
}

describe('MCP JSON-RPC handler', () => {
  it('echoes a supported protocol version and sends instructions', () => {
    const res = handleMcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        instructions: MCP_INSTRUCTIONS,
      },
    });
  });

  it('answers an unsupported initialize version with the newest legacy one it supports', () => {
    const res = handleMcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe(
      LEGACY_PROTOCOL_VERSIONS[0],
    );
  });

  it('ignores notifications without an id', () => {
    expect(handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('returns a JSON-RPC error for an unknown method', () => {
    const res = handleMcpRequest({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
    expect(res?.error?.code).toBe(-32601);
  });
});

describe('2026-07-28 requests (version in _meta, no initialize)', () => {
  const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION };

  it('answers server/discover with the modern version and cache hints', () => {
    const res = handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } });
    expect(res?.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: [MODERN_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS,
      cacheScope: 'public',
    });
  });

  it('lists tools and calls one without a handshake, marking each result complete', () => {
    const list = handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } });
    expect(list?.result).toMatchObject({ resultType: 'complete', cacheScope: 'public' });
    const call = handleMcpRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'estimate_tempo', arguments: { bpm: 120 }, _meta: meta },
    });
    expect((call?.result as { resultType: string }).resultType).toBe('complete');
  });

  it('refuses a modern version it does not speak and lists the one it does', () => {
    const res = handleMcpRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } },
    });
    expect(res?.error).toEqual({
      code: -32022,
      message: 'Unsupported protocol version: 2099-01-01',
      data: { supported: [MODERN_PROTOCOL_VERSION], requested: '2099-01-01' },
    });
  });

  it('leaves a legacy result without resultType', () => {
    const res = handleMcpRequest({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    expect(res?.result).toEqual({ tools: MCP_TOOLS });
  });
});

describe('tool definitions', () => {
  it('lists all 7 tools', () => {
    const res = handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res?.result).toEqual({ tools: MCP_TOOLS });
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      'get_social_media_placement',
      'list_social_media_placements',
      'check_safe_area',
      'calculate_aspect_ratio',
      'estimate_video_bitrate',
      'convert_subtitles',
      'estimate_tempo',
    ]);
  });

  it.each(MCP_TOOLS.map((t) => [t.name, t] as const))(
    '%s declares a title, read-only annotations and valid input/output schemas',
    (_name, tool) => {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.annotations).toEqual({
        title: tool.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.description.toLowerCase()).not.toBe(tool.name);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.type).toBe('object');
      expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
      expect(() => ajv.compile(tool.outputSchema)).not.toThrow();
      for (const prop of Object.values(tool.inputSchema.properties) as { description?: string }[]) {
        expect(prop.description?.length).toBeGreaterThan(0);
      }
    },
  );
});

describe('get_social_media_placement', () => {
  it('returns youtube-shorts with sourced safe areas and a fit plan', () => {
    const r = ok('get_social_media_placement', {
      id: 'youtube-shorts',
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(r.id).toBe('youtube-shorts');
    expect(r.safeAreaInsetsPx).toEqual({ top: 288, bottom: 672, left: 48, right: 192 });
    expect(r.usableBoxPx).toEqual({ width: 840, height: 960 });
    expect(r.firstPartySourceUrl).toBe('https://support.google.com/google-ads/answer/9128498');
    expect(r.fit.source).toEqual({ width: 1920, height: 1080 });
    expect(r.fit.crop.result).toEqual({ width: 608, height: 1080 });
  });

  it('returns fit null without source dimensions, and null insets with a reason for TikTok', () => {
    const r = ok('get_social_media_placement', { id: 'tiktok-video' });
    expect(r.fit).toBeNull();
    expect(r.safeAreaInsetsPx).toBeNull();
    expect(r.unpublishedReason).toMatch(/overlay template/);
  });

  it('rejects an unknown id and names the valid ones', () => {
    expect(fails('get_social_media_placement', { id: 'myspace-video' })).toMatch(
      /Unknown placement id "myspace-video".*instagram-reels/,
    );
  });

  it('rejects one source dimension without the other', () => {
    expect(fails('get_social_media_placement', { id: 'instagram-reels', sourceWidth: 1920 })).toMatch(
      /together/,
    );
  });
});

describe('list_social_media_placements', () => {
  it('lists every placement, or filters by platform', () => {
    const all = ok('list_social_media_placements', {});
    expect(all.count).toBe(all.placements.length);
    expect(all.platform).toBeNull();
    const ig = ok('list_social_media_placements', { platform: 'instagram' });
    expect(ig.placements.every((p: { platform: string }) => p.platform === 'instagram')).toBe(true);
    expect(ig.count).toBeLessThan(all.count);
  });

  it('rejects an unknown platform', () => {
    expect(fails('list_social_media_placements', { platform: 'myspace' })).toMatch(/Unknown platform/);
  });
});

describe('check_safe_area', () => {
  // instagram-reels: 1080x1920, insets 269 / 672 / 65 -> safe rect x 65, y 269, 950x979.
  it('reports a caption inside the Reels safe area', () => {
    const r = ok('check_safe_area', { placementId: 'instagram-reels', x: 100, y: 400, width: 800, height: 200 });
    expect(r.verdict).toBe('inside');
    expect(r.withinFrame).toBe(true);
    expect(r.safeRectPx).toEqual({ x: 65, y: 269, width: 950, height: 979 });
    expect(r.intrusionPx).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('reports how far a caption intrudes into the Reels bottom UI', () => {
    const r = ok('check_safe_area', { placementId: 'instagram-reels', x: 40, y: 1300, width: 800, height: 100 });
    expect(r.verdict).toBe('intrudes');
    expect(r.intrusionPx).toEqual({ top: 0, right: 0, bottom: 152, left: 25 });
  });

  it('flags a box that leaves the frame', () => {
    const r = ok('check_safe_area', { placementId: 'instagram-reels', x: 1000, y: 400, width: 200, height: 100 });
    expect(r.withinFrame).toBe(false);
    expect(r.verdict).toBe('intrudes');
  });

  it('answers unknown with the reason for TikTok instead of guessing', () => {
    const r = ok('check_safe_area', { placementId: 'tiktok-video', x: 0, y: 0, width: 100, height: 100 });
    expect(r.verdict).toBe('unknown');
    expect(r.safeRectPx).toBeNull();
    expect(r.intrusionPx).toBeNull();
    expect(r.unpublishedReason).toMatch(/overlay template/);
  });

  it('rejects a box with no area and a missing coordinate', () => {
    expect(fails('check_safe_area', { placementId: 'instagram-reels', x: 0, y: 0, width: 0, height: 10 })).toMatch(
      /greater than 0/,
    );
    expect(fails('check_safe_area', { placementId: 'instagram-reels', y: 0, width: 10, height: 10 })).toMatch(
      /x is required/,
    );
  });
});

describe('calculate_aspect_ratio', () => {
  it('simplifies, aligns, and plans a 9:16 crop and pad', () => {
    const r = ok('calculate_aspect_ratio', { width: 1920, height: 1080, targetRatioW: 9, targetRatioH: 16 });
    expect(r.formattedRatio).toBe('16:9');
    expect(r.blockSize).toBe(2);
    expect(r.cropPlan.result).toEqual({ width: 608, height: 1080 });
    expect(r.padPlan.result).toEqual({ width: 1920, height: 3413 });
  });

  it('aligns to a custom block with no target ratio', () => {
    const r = ok('calculate_aspect_ratio', { width: 1080, height: 1920, blockSize: 16 });
    expect(r.alignedToBlock).toEqual({ width: 1088, height: 1920 });
    expect(r.cropPlan).toBeNull();
    expect(r.targetRatio).toBeNull();
  });

  it('rejects missing or fractional sizes and a half-specified target ratio', () => {
    expect(fails('calculate_aspect_ratio', { width: 1920 })).toMatch(/height is required/);
    expect(fails('calculate_aspect_ratio', { width: 1920.5, height: 1080 })).toMatch(/whole pixels/);
    expect(fails('calculate_aspect_ratio', { width: 1920, height: 1080, targetRatioW: 9 })).toMatch(/together/);
    expect(fails('calculate_aspect_ratio', { width: 1920, height: 1080, blockSize: 0 })).toMatch(/blockSize/);
  });
});

describe('estimate_video_bitrate', () => {
  it('computes file size, max bitrate for a cap, and bits per pixel', () => {
    const r = ok('estimate_video_bitrate', {
      durationSec: 60,
      totalKbps: 8000,
      targetBytes: 25_000_000,
      widthPx: 1920,
      heightPx: 1080,
      fps: 30,
    });
    expect(r.estimatedBytes).toBe(60_000_000);
    expect(r.formattedDecimal).toBe('60.00 MB');
    expect(r.targetBitrateKbps).toBe(3333.33);
    expect(r.bitsPerPixel).toBe(0.1286);
  });

  it('solves for a size cap alone', () => {
    const r = ok('estimate_video_bitrate', { durationSec: 30, targetBytes: 10_000_000 });
    expect(r.targetBitrateKbps).toBe(2666.67);
    expect(r.estimatedBytes).toBeNull();
  });

  it('rejects a call with neither mode, a bad duration, or partial bits-per-pixel inputs', () => {
    expect(fails('estimate_video_bitrate', { durationSec: 60 })).toMatch(/totalKbps .* or targetBytes/);
    expect(fails('estimate_video_bitrate', { totalKbps: 8000 })).toMatch(/durationSec is required/);
    expect(fails('estimate_video_bitrate', { durationSec: 0, totalKbps: 8000 })).toMatch(/greater than 0/);
    expect(fails('estimate_video_bitrate', { durationSec: 60, totalKbps: 8000, widthPx: 1920 })).toMatch(
      /Bits per pixel needs/,
    );
  });
});

describe('convert_subtitles', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello world\n';

  it('detects SRT and converts to VTT', () => {
    const r = ok('convert_subtitles', { input: srt, toFormat: 'vtt' });
    expect(r.fromFormat).toBe('srt');
    expect(r.cueCount).toBe(1);
    expect(r.output).toContain('WEBVTT');
    expect(r.output).toContain('00:00:01.000 --> 00:00:02.000');
  });

  it('shifts cues and warns about ASS centisecond rounding', () => {
    const r = ok('convert_subtitles', { input: srt, toFormat: 'ass', shiftMs: 500 });
    expect(r.shiftMs).toBe(500);
    expect(r.output).toContain('0:00:01.50');
    expect(r.warnings.some((w: string) => /centiseconds/.test(w))).toBe(true);
  });

  it('rejects an unknown target, undetectable input, and input with no cues', () => {
    expect(fails('convert_subtitles', { input: srt, toFormat: 'docx' })).toMatch(/toFormat must be one of/);
    expect(fails('convert_subtitles', { input: 'just some text', toFormat: 'vtt' })).toMatch(/Pass fromFormat/);
    expect(fails('convert_subtitles', { input: 'just some text', toFormat: 'vtt', fromFormat: 'srt' })).toMatch(
      /No cues could be parsed as srt/,
    );
    expect(fails('convert_subtitles', { input: '   ', toFormat: 'vtt' })).toMatch(/file contents/);
  });
});

describe('estimate_tempo', () => {
  it('gives beat and bar length for a known BPM', () => {
    const r = ok('estimate_tempo', { bpm: 120 });
    expect(r.estimate).toBeNull();
    expect(r.quarterNoteMs).toBe(500);
    expect(r.barMs4_4).toBe(2000);
  });

  it('estimates BPM from steady taps', () => {
    const r = ok('estimate_tempo', { timestampsMs: [0, 500, 1000, 1500, 2000] });
    expect(r.estimate.bpm).toBe(120);
    expect(r.bpm).toBe(120);
  });

  it('rejects no input, too few taps, and an out-of-range BPM', () => {
    expect(fails('estimate_tempo', {})).toMatch(/Pass timestampsMs/);
    expect(fails('estimate_tempo', { timestampsMs: [1000] })).toMatch(/at least two taps/);
    expect(fails('estimate_tempo', { bpm: 500 })).toMatch(/between 20 and 400/);
  });
});

describe('unknown tools', () => {
  it('returns a tool error pointing at tools/list', () => {
    expect(fails('delete_everything', {})).toMatch(/tools\/list/);
  });
});
