import { describe, expect, it } from 'vitest';
import { handleMcpRequest, MCP_SERVER_INFO, MCP_TOOLS } from '../src/mcp.js';

describe('MCP JSON-RPC handler', () => {
  it('responds to initialize with server capabilities and version', () => {
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
      },
    });
  });

  it('ignores notifications without an id', () => {
    expect(
      handleMcpRequest({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    ).toBeNull();
  });

  it('lists all 6 creator tools', () => {
    const res = handleMcpRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(res?.result).toEqual({ tools: MCP_TOOLS });
    expect(MCP_TOOLS).toHaveLength(6);
  });

  it('executes get_social_media_placement for youtube-shorts with sourced safe areas', () => {
    const res = handleMcpRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_social_media_placement',
        arguments: {
          id: 'youtube-shorts',
          sourceWidth: 1920,
          sourceHeight: 1080,
        },
      },
    });
    const content = (res?.result as { content: { text: string }[] }).content[0]!;
    const parsed = JSON.parse(content.text);
    expect(parsed.id).toBe('youtube-shorts');
    expect(parsed.safeAreaInsetsPx).toEqual({
      top: 288,
      bottom: 672,
      left: 48,
      right: 192,
    });
    expect(parsed.usableBoxPx).toEqual({ width: 840, height: 960 });
    expect(parsed.firstPartySourceUrl).toBe(
      'https://support.google.com/google-ads/answer/9128498',
    );
    expect(parsed.referenceToolUrl).toBe(
      'https://www.prismposter.com/tools/social-media-sizes',
    );
    expect(parsed.fit).toBeDefined();
  });

  it('executes calculate_aspect_ratio, estimate_video_bitrate, convert_subtitles, and estimate_tempo', () => {
    const ar = handleMcpRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'calculate_aspect_ratio',
        arguments: { width: 1920, height: 1080, targetRatioW: 9, targetRatioH: 16 },
      },
    });
    const arJson = JSON.parse(
      (ar?.result as { content: { text: string }[] }).content[0]!.text,
    );
    expect(arJson.formattedRatio).toBe('16:9');
    expect(arJson.cropPlan.result).toEqual({ width: 608, height: 1080 });

    const br = handleMcpRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'estimate_video_bitrate',
        arguments: { durationSec: 60, totalKbps: 8000 },
      },
    });
    const brJson = JSON.parse(
      (br?.result as { content: { text: string }[] }).content[0]!.text,
    );
    expect(brJson.estimatedBytes).toBe(60_000_000);

    const sub = handleMcpRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'convert_subtitles',
        arguments: {
          input: '1\n00:00:01,000 --> 00:00:02,000\nHello world\n',
          toFormat: 'vtt',
        },
      },
    });
    const subJson = JSON.parse(
      (sub?.result as { content: { text: string }[] }).content[0]!.text,
    );
    expect(subJson.cueCount).toBe(1);
    expect(subJson.output).toContain('WEBVTT');

    const tempo = handleMcpRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'estimate_tempo',
        arguments: { bpm: 120 },
      },
    });
    const tempoJson = JSON.parse(
      (tempo?.result as { content: { text: string }[] }).content[0]!.text,
    );
    expect(tempoJson.quarterNoteMs).toBe(500);
  });
});
