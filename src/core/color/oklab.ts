/**
 * Oklab / Oklch conversions for linear Display-P3.
 *
 * Saturation is scaled as Oklch chroma rather than HSV saturation: an HSV scale
 * rotates hue and drives red — which is where skin and lips sit — into clipping
 * ahead of everything else.
 */

import { mat3Apply, type Vec3 } from './matrix';
import { DISPLAY_P3_TO_LMS, LMS_TO_DISPLAY_P3, LMS_TO_OKLAB, OKLAB_TO_LMS } from './spaces';

/** Cube root that keeps the sign, so out-of-gamut negatives survive the trip. */
function cbrtSigned(x: number): number {
  return Math.sign(x) * Math.abs(x) ** (1 / 3);
}

export function linearP3ToOklab(rgb: Vec3): Vec3 {
  const lms = mat3Apply(DISPLAY_P3_TO_LMS, rgb);
  return mat3Apply(LMS_TO_OKLAB, [cbrtSigned(lms[0]), cbrtSigned(lms[1]), cbrtSigned(lms[2])]);
}

export function oklabToLinearP3(lab: Vec3): Vec3 {
  const lms = mat3Apply(OKLAB_TO_LMS, lab);
  return mat3Apply(LMS_TO_DISPLAY_P3, [lms[0] ** 3, lms[1] ** 3, lms[2] ** 3]);
}

/** Oklab to Oklch: lightness, chroma, hue in radians. */
export function oklabToOklch(lab: Vec3): Vec3 {
  return [lab[0], Math.hypot(lab[1], lab[2]), Math.atan2(lab[2], lab[1])];
}

export function oklchToOklab(lch: Vec3): Vec3 {
  return [lch[0], lch[1] * Math.cos(lch[2]), lch[1] * Math.sin(lch[2])];
}

/**
 * Centre of the skin hue band in Oklab, in radians.
 *
 * Skin sits in a narrow wedge of warm hues. Saturation gains are attenuated
 * inside it so that lifting colour elsewhere does not turn faces red.
 */
export const SKIN_HUE_CENTER = 0.68;

/** Half-width of the skin hue band, in radians. */
export const SKIN_HUE_WIDTH = 0.55;

/**
 * How strongly a hue belongs to the skin band, 1 at the centre and 0 outside it.
 */
export function skinHueWeight(hue: number): number {
  let d = hue - SKIN_HUE_CENTER;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const t = Math.min(1, Math.abs(d) / SKIN_HUE_WIDTH);
  return 1 - t * t * (3 - 2 * t);
}
