/**
 * Is there provenance on this file, and does it say the asset was AI-generated?
 *
 * Two independent markings are in circulation and they are routinely confused:
 *
 *   1. A **C2PA manifest** — a cryptographically signed Content Credential,
 *      stored in a JUMBF box inside the file.
 *   2. An **IPTC digital source type** — a plain metadata field, written into
 *      XMP/EXIF, with no signature at all.
 *
 * A file can carry either, both, or neither, and a great many "AI detector"
 * write-ups treat the second as if it were the first. This module reports them
 * separately, because they carry completely different weight: one is tamper
 * evident, the other is a string anybody can write with `exiftool`.
 *
 * It does **not** verify a signature. `signatureVerified` is always `false`,
 * deliberately — proving a manifest is valid needs the full C2PA trust list and
 * certificate-chain validation, which is what `c2patool` and `c2pa-node` are
 * for. This answers the cheaper question those are overkill for: *is a
 * credential present, and what does it claim?* That is the check you actually
 * want in an upload pipeline, a moderation queue or a CI assertion, where you
 * are triaging thousands of files and only need to route the interesting ones
 * to a real verifier.
 *
 * The distinction is stated this loudly because conflating the two is the
 * standard way provenance claims get overstated. **A present manifest is not a
 * trusted manifest.** Anyone can sign anything with a self-signed certificate,
 * including a lie.
 */

/** JUMBF is the container a C2PA manifest lives in, in every supported format. */
const JUMBF_BOX_TYPE = 'jumb';
const C2PA_LABEL = 'c2pa';

/**
 * The IPTC digital source type that declares synthetic media. This exact IRI is
 * what the EU AI Act Article 50(2) machine-readable marking duty is met with in
 * practice, so it is the single most useful string to look for.
 */
export const TRAINED_ALGORITHMIC_MEDIA =
  'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';

/** Synthetic or partly-synthetic source types in the IPTC vocabulary. */
export const SYNTHETIC_SOURCE_TYPES = [
  TRAINED_ALGORITHMIC_MEDIA,
  'http://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic',
  'http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia',
  'http://cv.iptc.org/newscodes/digitalsourcetype/virtualRecording',
] as const;

/** Source types that assert a human-captured original rather than synthesis. */
export const CAPTURED_SOURCE_TYPES = [
  'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture',
  'http://cv.iptc.org/newscodes/digitalsourcetype/negativeFilm',
  'http://cv.iptc.org/newscodes/digitalsourcetype/positiveFilm',
  'http://cv.iptc.org/newscodes/digitalsourcetype/print',
] as const;

/**
 * Assertion labels the C2PA spec defines.
 *
 * A manifest's internals are CBOR. Reading the plain-string fields inside the
 * JUMBF container is what keeps this dependency-free, but a raw scan runs
 * happily past a label's end and into the next field — an early draft of this
 * reported `c2pa.createdqdigital` and `c2pa.hash.datadhash` as though they were
 * real labels. Matching against the known vocabulary means a reported label is
 * either real or absent, which is the only version a caller can trust.
 */
const KNOWN_ASSERTION_LABELS = [
  'c2pa.actions.v2',
  'c2pa.actions',
  'c2pa.assertions',
  'c2pa.claim.v2',
  'c2pa.claim_thumbnail',
  'c2pa.claim',
  'c2pa.hash.bmff.v2',
  'c2pa.hash.bmff',
  'c2pa.hash.boxes',
  'c2pa.hash.data',
  'c2pa.ingredient.v3',
  'c2pa.ingredient.v2',
  'c2pa.ingredient',
  'c2pa.metadata',
  'c2pa.signature',
  'c2pa.soft-binding',
  'c2pa.thumbnail.ingredient',
  'c2pa.thumbnail.claim',
  'c2pa.thumbnail',
] as const;

export type BytesLike = Uint8Array | ArrayBuffer;

export interface ProvenanceReport {
  /** A JUMBF box carrying a C2PA label was found. */
  hasC2paManifest: boolean;
  /** An IPTC digital source type was found in plain metadata (XMP/EXIF). */
  hasIptcSourceType: boolean;
  /** Any marking at all — the union of the two above. */
  hasProvenance: boolean;
  /** A marking asserts the asset is synthetic. */
  declaresAiGenerated: boolean;
  /** A marking asserts a camera/film/print origin instead. */
  declaresCapture: boolean;
  /** Every IPTC source-type IRI found, sorted. */
  digitalSourceTypes: string[];
  /** Spec-defined C2PA assertion labels found, sorted. */
  assertionLabels: string[];
  /** Byte offset of the first C2PA JUMBF box, or null. */
  manifestOffset: number | null;
  /**
   * Always `false`. Present so a caller cannot mistake "found" for "trusted",
   * and so a future signature-checking release can flip it without changing the
   * shape of this object.
   */
  signatureVerified: false;
}

function toBytes(input: BytesLike): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('Expected a Uint8Array or ArrayBuffer');
}

/** Latin-1 view of the bytes: every byte maps to exactly one character. */
function latin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return out;
}

/**
 * Inspect bytes for provenance markings.
 *
 * Accepts a `Uint8Array` or `ArrayBuffer`; throws `TypeError` on anything else
 * rather than guessing. Works on any format that can carry the markings —
 * JPEG, PNG, WebP, MP4, and friends — because it reads the containers' shared
 * conventions rather than parsing each format.
 */
export function inspectProvenance(input: BytesLike): ProvenanceReport {
  const bytes = toBytes(input);
  const text = latin1(bytes);

  const report: ProvenanceReport = {
    hasC2paManifest: false,
    hasIptcSourceType: false,
    hasProvenance: false,
    declaresAiGenerated: false,
    declaresCapture: false,
    digitalSourceTypes: [],
    assertionLabels: [],
    manifestOffset: null,
    signatureVerified: false,
  };

  // --- C2PA manifest -------------------------------------------------------
  // A JUMBF box is `<4-byte length><"jumb">`, so the type never sits at 0..3,
  // and the c2pa label follows close behind it inside the box header.
  let from = 0;
  for (;;) {
    const at = text.indexOf(JUMBF_BOX_TYPE, from);
    if (at === -1) break;
    if (at >= 4 && text.slice(at, at + 200).includes(C2PA_LABEL)) {
      report.hasC2paManifest = true;
      report.manifestOffset = at - 4;
      break;
    }
    from = at + 4;
  }

  // --- IPTC digital source type -------------------------------------------
  const sourceTypes = new Set<string>();
  const iri = /https?:\/\/cv\.iptc\.org\/newscodes\/digitalsourcetype\/[A-Za-z]+/g;
  for (const match of text.matchAll(iri)) sourceTypes.add(match[0]);

  report.digitalSourceTypes = [...sourceTypes].sort();
  report.hasIptcSourceType = sourceTypes.size > 0;

  // --- Claims --------------------------------------------------------------
  report.declaresAiGenerated = SYNTHETIC_SOURCE_TYPES.some((t) => sourceTypes.has(t));
  report.declaresCapture = CAPTURED_SOURCE_TYPES.some((t) => sourceTypes.has(t));

  if (report.hasC2paManifest) {
    const labels = new Set<string>();
    for (const label of KNOWN_ASSERTION_LABELS) {
      if (text.includes(label)) labels.add(label);
    }
    report.assertionLabels = [...labels].sort();
  }

  report.hasProvenance = report.hasC2paManifest || report.hasIptcSourceType;
  return report;
}

/** Does this asset carry a C2PA Content Credential at all? */
export function hasC2paManifest(input: BytesLike): boolean {
  return inspectProvenance(input).hasC2paManifest;
}

/**
 * Does any marking on this asset declare it AI-generated?
 *
 * True for a C2PA manifest asserting a synthetic source type AND for a bare
 * XMP/EXIF field asserting one. Use `inspectProvenance` when you need to know
 * which, because only the first is tamper evident.
 */
export function declaresAiGenerated(input: BytesLike): boolean {
  return inspectProvenance(input).declaresAiGenerated;
}
