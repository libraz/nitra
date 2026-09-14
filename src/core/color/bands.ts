/**
 * Where each named colour actually sits, in Oklab hue.
 *
 * The angles are computed from the primaries rather than typed in, for the same
 * reason the colour matrices are: a hand-copied hue angle is a number nothing
 * checks, and a band centred a few degrees off pulls a neighbouring colour with
 * it when it moves.
 *
 * Band widths come out of the spacing. Each band reaches as far as its furthest
 * neighbour, so every hue belongs to at least one band and no hue falls in a gap
 * where the per-colour sliders would simply do nothing.
 */

import { HUE_BANDS, type HueBand } from '../recipe/schema';
import { mat3Apply, type Vec3 } from './matrix';
import { linearP3ToOklab, oklabToOklch } from './oklab';
import { SRGB_TO_DISPLAY_P3, transferToLinear } from './spaces';

/** The colour each band is named after, as it would be written in CSS. */
const REFERENCE: Record<HueBand, [number, number, number]> = {
  red: [1, 0, 0],
  orange: [1, 0.5, 0],
  yellow: [1, 1, 0],
  green: [0, 1, 0],
  cyan: [0, 1, 1],
  blue: [0, 0, 1],
  purple: [0.5, 0, 1],
  magenta: [1, 0, 1],
};

function referenceHue(band: HueBand): number {
  const srgb = REFERENCE[band].map(transferToLinear) as unknown as Vec3;
  const lab = linearP3ToOklab(mat3Apply(SRGB_TO_DISPLAY_P3, srgb));
  const hue = oklabToOklch(lab)[2];
  return hue < 0 ? hue + 2 * Math.PI : hue;
}

/** Band centres in Oklab hue, radians in `[0, 2π)`, in {@link HUE_BANDS} order. */
export const BAND_HUES: readonly number[] = HUE_BANDS.map(referenceHue);

function angularGap(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
}

/** Half-width of each band, radians: far enough to meet both its neighbours. */
export const BAND_WIDTHS: readonly number[] = BAND_HUES.map((hue, i) => {
  const prev = BAND_HUES[(i - 1 + BAND_HUES.length) % BAND_HUES.length] as number;
  const next = BAND_HUES[(i + 1) % BAND_HUES.length] as number;
  return Math.max(angularGap(hue, prev), angularGap(hue, next));
});
