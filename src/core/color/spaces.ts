/**
 * Colour spaces and transfer functions.
 *
 * The working space is linear Display-P3. Everything that enters the pipeline is
 * converted to it once at ingest and everything that leaves is converted out of
 * it once at encode; no stage in between knows about a display.
 */

import { type Mat3, mat3Inverse, mat3Mul } from './matrix';

/** Colour spaces a source image or an exported file can be tagged with. */
export type ColorSpaceName = 'srgb' | 'display-p3';

/** Linear Display-P3 to CIE XYZ (D65). */
export const DISPLAY_P3_TO_XYZ: Mat3 = [
  0.4865709486, 0.2656676932, 0.1982172852, 0.2289745641, 0.6917385218, 0.0792869141, 0.0,
  0.0451133819, 1.0439443689,
];

/** Linear sRGB to CIE XYZ (D65). */
export const SRGB_TO_XYZ: Mat3 = [
  0.4123907993, 0.3575843394, 0.1804807884, 0.2126390059, 0.7151686788, 0.072192319, 0.0193308187,
  0.1191947798, 0.9505321522,
];

export const XYZ_TO_DISPLAY_P3 = mat3Inverse(DISPLAY_P3_TO_XYZ);
export const XYZ_TO_SRGB = mat3Inverse(SRGB_TO_XYZ);

export const DISPLAY_P3_TO_SRGB = mat3Mul(XYZ_TO_SRGB, DISPLAY_P3_TO_XYZ);
export const SRGB_TO_DISPLAY_P3 = mat3Mul(XYZ_TO_DISPLAY_P3, SRGB_TO_XYZ);

/** CIE XYZ to the cone response the Oklab construction is built on. */
export const XYZ_TO_LMS: Mat3 = [
  0.8189330101, 0.3618667424, -0.1288597137, 0.0329845436, 0.9293118715, 0.0361456387, 0.0482003018,
  0.2643662691, 0.633851707,
];

/** Non-linear cone response to Oklab. */
export const LMS_TO_OKLAB: Mat3 = [
  0.2104542553, 0.793617785, -0.0040720468, 1.9779984951, -2.428592205, 0.4505937099, 0.0259040371,
  0.7827717662, -0.808675766,
];

export const LMS_TO_XYZ = mat3Inverse(XYZ_TO_LMS);
export const OKLAB_TO_LMS = mat3Inverse(LMS_TO_OKLAB);

/**
 * Scale each row so that an equal-energy input maps to an equal-energy output.
 *
 * Composing two published matrices leaves the working space's white a hundred
 * microunits off the cone response Oklab is defined against, which gives neutral
 * grey a trace of chroma. It is far below anything visible, but a saturation
 * stage that multiplies chroma has no way to tell a trace from a colour, so the
 * adaptation is done once here and grey stays grey by construction.
 */
function adaptToWhite(m: Mat3): Mat3 {
  const out = [...m] as number[];
  for (let row = 0; row < 3; row++) {
    const sum = (m[row * 3] as number) + (m[row * 3 + 1] as number) + (m[row * 3 + 2] as number);
    for (let col = 0; col < 3; col++) out[row * 3 + col] = (m[row * 3 + col] as number) / sum;
  }
  return out as unknown as Mat3;
}

/** Linear Display-P3 straight to the Oklab cone response. */
export const DISPLAY_P3_TO_LMS = adaptToWhite(mat3Mul(XYZ_TO_LMS, DISPLAY_P3_TO_XYZ));
export const LMS_TO_DISPLAY_P3 = mat3Inverse(DISPLAY_P3_TO_LMS);

/**
 * sRGB electro-optical transfer function.
 *
 * Display-P3 shares this curve with sRGB and differs only in primaries, so the
 * same pair serves both encodings.
 */
export function transferToLinear(c: number): number {
  const a = Math.abs(c);
  const l = a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4;
  return c < 0 ? -l : l;
}

/** Inverse of {@link transferToLinear}. */
export function transferFromLinear(l: number): number {
  const a = Math.abs(l);
  const c = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055;
  return l < 0 ? -c : c;
}

/** Matrix taking the working space to an output space's linear primaries. */
export function workingToOutputMatrix(space: ColorSpaceName): Mat3 {
  return space === 'srgb' ? DISPLAY_P3_TO_SRGB : ([1, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3);
}

/** Relative luminance of a linear Display-P3 triple. */
export function luminanceP3(r: number, g: number, b: number): number {
  return DISPLAY_P3_TO_XYZ[3] * r + DISPLAY_P3_TO_XYZ[4] * g + DISPLAY_P3_TO_XYZ[5] * b;
}
