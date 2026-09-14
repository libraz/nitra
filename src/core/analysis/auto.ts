/**
 * Automatic starting values.
 *
 * A slider that starts somewhere sensible changes the experience more than an
 * extra slider does, so this runs off the image rather than off a fixed preset.
 *
 * What it can see today is the whole frame: exposure, where the tones sit, and
 * how much is already clipped. The judgements that need a face — how uneven the
 * skin is, whether the subject is backlit rather than the scene being dark —
 * arrive with face analysis, and the shape of this function is what they slot
 * into.
 */

import type { GlobalParams } from '../recipe/schema';
import type { RenderStats } from '../render/pipeline';

/** Mid-grey as it lands in a display-referred histogram. */
const TARGET_MEAN = 0.46;

/** Percentile lookup over the histogram, returned in 0..1. */
function percentile(histogram: Uint32Array, fraction: number): number {
  let total = 0;
  for (const n of histogram) total += n;
  if (total === 0) return 0;
  const want = total * fraction;
  let seen = 0;
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i] as number;
    if (seen >= want) return (i + 0.5) / histogram.length;
  }
  return 1;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * What the measurement found, as data rather than a sentence.
 *
 * The wording belongs to the message catalogue; keeping the reason structured is
 * what lets it be said in any language without this file knowing one.
 */
export type AutoNote =
  | { kind: 'exposure'; stops: number }
  | { kind: 'blackPoint' }
  | { kind: 'whitePoint' }
  | { kind: 'highlightClip'; percent: number }
  | { kind: 'shadowClip'; percent: number }
  | { kind: 'balanced' };

export interface AutoSuggestion {
  params: Partial<GlobalParams>;
  notes: AutoNote[];
}

/**
 * Derive a starting grade from a measurement of the untouched image.
 *
 * `stats` must come from a neutral recipe: measuring the already-graded result
 * would fold the previous suggestion back into the next one.
 */
export function suggestGrade(stats: RenderStats): AutoSuggestion {
  const notes: AutoNote[] = [];
  const params: Partial<GlobalParams> = {};

  // Display-referred ratios are roughly the 2.2-th root of the light ratio, so
  // the correction is scaled back up into stops before becoming a slider value.
  const stops = 2.2 * Math.log2(TARGET_MEAN / Math.max(stats.meanLuma, 0.02));
  const exposure = clamp(stops / 3, -0.6, 0.6);
  if (Math.abs(exposure) > 0.02) {
    params.exposure = exposure;
    notes.push({ kind: 'exposure', stops });
  }

  const low = percentile(stats.histogram, 0.005);
  const high = percentile(stats.histogram, 0.995);

  // A histogram that never reaches the ends is a flat photo; pulling the end
  // points in is the correction with the largest effect for the least risk.
  if (low > 0.09) {
    params.blacks = clamp(-(low - 0.06) * 3, -0.5, 0);
    notes.push({ kind: 'blackPoint' });
  }
  if (high < 0.88) {
    params.whites = clamp((0.94 - high) * 2.5, 0, 0.5);
    notes.push({ kind: 'whitePoint' });
  }

  if (stats.highlightClip > 0.02) {
    params.highlights = clamp(-stats.highlightClip * 6, -0.6, 0);
    notes.push({ kind: 'highlightClip', percent: stats.highlightClip * 100 });
  }
  if (stats.shadowClip > 0.04) {
    params.shadows = clamp(stats.shadowClip * 4, 0, 0.5);
    notes.push({ kind: 'shadowClip', percent: stats.shadowClip * 100 });
  }

  // Vibrance rather than saturation, and with skin protection on: a global
  // colour lift is what turns faces red, and these two are what stop it.
  params.vibrance = 0.14;
  params.skinHueProtect = 0.8;
  if (notes.length === 0) notes.push({ kind: 'balanced' });

  return { params, notes };
}
