import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  inspectProvenance,
  hasC2paManifest,
  declaresAiGenerated,
  TRAINED_ALGORITHMIC_MEDIA,
} from '../src/provenance.js';

/**
 * A genuine C2PA-signed PNG produced by c2patool, not a hand-assembled byte
 * pattern — so these fail if a real-world manifest layout stops being
 * recognised, which a synthetic fixture would happily keep passing through.
 */
const FIXTURE = join(__dirname, 'signed-ai.png');

/** The same 1x1 image before signing: the only difference is the manifest. */
const UNSIGNED = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
);

describe('provenance', () => {
  it('reports nothing on a plain image', () => {
    const report = inspectProvenance(UNSIGNED);
    expect(report.hasC2paManifest).toBe(false);
    expect(report.hasIptcSourceType).toBe(false);
    expect(report.hasProvenance).toBe(false);
    expect(report.declaresAiGenerated).toBe(false);
    expect(report.manifestOffset).toBeNull();
    expect(report.digitalSourceTypes).toEqual([]);
  });

  it.runIf(existsSync(FIXTURE))('finds a real C2PA manifest', () => {
    const signed = readFileSync(FIXTURE);
    const report = inspectProvenance(signed);
    expect(report.hasC2paManifest).toBe(true);
    expect(report.hasProvenance).toBe(true);
    expect(report.manifestOffset).toBeGreaterThan(0);
    expect(hasC2paManifest(signed)).toBe(true);
  });

  it.runIf(existsSync(FIXTURE))('reads the AI-generated declaration', () => {
    const signed = readFileSync(FIXTURE);
    const report = inspectProvenance(signed);
    expect(report.declaresAiGenerated).toBe(true);
    expect(declaresAiGenerated(signed)).toBe(true);
    expect(report.digitalSourceTypes).toContain(TRAINED_ALGORITHMIC_MEDIA);
    expect(report.declaresCapture).toBe(false);
  });

  it.runIf(existsSync(FIXTURE))('reports only spec-defined assertion labels', () => {
    const report = inspectProvenance(readFileSync(FIXTURE));
    expect(report.assertionLabels).toContain('c2pa.actions.v2');
    // A raw scan runs past a label into the next CBOR field; an early draft
    // emitted "c2pa.createdqdigital". Every label must be one the spec defines.
    for (const label of report.assertionLabels) {
      expect(label).toMatch(/^c2pa\.[a-z0-9_.-]+$/);
    }
    expect(report.assertionLabels).not.toContain('c2pa.createdqdigital');
  });

  it.runIf(existsSync(FIXTURE))('never claims a signature was verified', () => {
    // The library's central promise. If this is ever true, the README lies.
    expect(inspectProvenance(readFileSync(FIXTURE)).signatureVerified).toBe(false);
    expect(inspectProvenance(UNSIGNED).signatureVerified).toBe(false);
  });

  it('separates an unsigned IPTC marker from a signed credential', () => {
    // An XMP field anyone can write with exiftool — no manifest, no signature.
    const xmp = new TextEncoder().encode(
      `<x:xmpmeta><Iptc4xmpExt:DigitalSourceType>${TRAINED_ALGORITHMIC_MEDIA}</Iptc4xmpExt:DigitalSourceType></x:xmpmeta>`
    );
    const report = inspectProvenance(xmp);
    expect(report.hasIptcSourceType).toBe(true);
    expect(report.declaresAiGenerated).toBe(true);
    // The point of the module: this is NOT a Content Credential.
    expect(report.hasC2paManifest).toBe(false);
    expect(report.assertionLabels).toEqual([]);
  });

  it('recognises a capture assertion as not-synthetic', () => {
    const xmp = new TextEncoder().encode(
      'DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture<'
    );
    const report = inspectProvenance(xmp);
    expect(report.declaresCapture).toBe(true);
    expect(report.declaresAiGenerated).toBe(false);
  });

  it('does not false-positive on the ascii word "jumb"', () => {
    const decoy = new TextEncoder().encode('a plumber jumbled the jumbo jumb');
    expect(hasC2paManifest(decoy)).toBe(false);
  });

  it('accepts ArrayBuffer and rejects anything else', () => {
    const ab = UNSIGNED.buffer.slice(0);
    expect(hasC2paManifest(ab)).toBe(false);
    // @ts-expect-error deliberately wrong input
    expect(() => inspectProvenance('not bytes')).toThrow(TypeError);
  });
});
