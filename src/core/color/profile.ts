/**
 * Which known space a file's colour description names.
 *
 * Only the two spaces the pipeline can be told about are recognised. A profile
 * is identified by its colorants rather than by its description string, which is
 * free text and differs between vendors writing the same primaries.
 */

import { type Mat3, mat3Apply, mat3Inverse, mat3Mul, type Vec3 } from './matrix';
import { type ColorSpaceName, DISPLAY_P3_TO_XYZ, SRGB_TO_XYZ } from './spaces';

/** Bradford cone response, the adaptation ICC v4 profiles are written with. */
const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

/** The ICC profile connection space white. */
const D50: Vec3 = [0.9642, 1, 0.8249];

/** How far an ICC colorant may sit from a known one, in XYZ. P3 red is 0.08 from sRGB red. */
const COLORANT_TOLERANCE = 0.01;

/** Adapt an RGB-to-XYZ matrix from its own white to D50, as an ICC profile carries it. */
function toD50(m: Mat3): Mat3 {
  const white = mat3Apply(m, [1, 1, 1]);
  const from = mat3Apply(BRADFORD, white);
  const to = mat3Apply(BRADFORD, D50);
  const scale: Mat3 = [to[0] / from[0], 0, 0, 0, to[1] / from[1], 0, 0, 0, to[2] / from[2]];
  return mat3Mul(mat3Inverse(BRADFORD), mat3Mul(scale, mat3Mul(BRADFORD, m)));
}

const KNOWN: readonly [ColorSpaceName, Mat3][] = [
  ['srgb', toD50(SRGB_TO_XYZ)],
  ['display-p3', toD50(DISPLAY_P3_TO_XYZ)],
];

/** Read a tag's XYZ triple out of an ICC profile, or null when it is absent. */
function colorant(icc: DataView, signature: string): Vec3 | null {
  if (icc.byteLength < 132) return null;
  const count = icc.getUint32(128);
  for (let i = 0; i < count; i++) {
    const entry = 132 + i * 12;
    if (entry + 12 > icc.byteLength) return null;
    let sig = '';
    for (let k = 0; k < 4; k++) sig += String.fromCharCode(icc.getUint8(entry + k));
    if (sig !== signature) continue;
    const offset = icc.getUint32(entry + 4);
    if (offset + 20 > icc.byteLength) return null;
    const fixed = (at: number) => icc.getInt32(offset + at) / 65536;
    return [fixed(8), fixed(12), fixed(16)];
  }
  return null;
}

/** The space an ICC profile's colorants describe, or null for anything else. */
export function iccSpace(icc: Uint8Array): ColorSpaceName | null {
  const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const columns = [colorant(view, 'rXYZ'), colorant(view, 'gXYZ'), colorant(view, 'bXYZ')];
  if (columns.some((c) => c === null)) return null;
  for (const [space, m] of KNOWN) {
    const matches = columns.every((c, col) =>
      (c as Vec3).every(
        (v, row) => Math.abs(v - (m[row * 3 + col] as number)) < COLORANT_TOLERANCE,
      ),
    );
    if (matches) return space;
  }
  return null;
}

/** The space an ITU-T H.273 `colour_primaries` code names, or null for anything else. */
export function nclxSpace(primaries: number): ColorSpaceName | null {
  // 1 is BT.709, which sRGB shares; 12 is SMPTE EG 432-1, Display-P3's primaries.
  if (primaries === 1) return 'srgb';
  if (primaries === 12) return 'display-p3';
  return null;
}
