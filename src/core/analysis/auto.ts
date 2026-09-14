/**
 * Automatic starting values.
 *
 * A slider that starts somewhere sensible changes the experience more than an
 * extra slider does, so this runs off the image rather than off a fixed preset.
 *
 * It branches on whether there is a face, because the two cases are different
 * photographs and not two strengths of the same one. Without a face the frame
 * is the subject: its histogram is the whole story, and holding saturation back
 * off the skin hues would only be holding it back off autumn leaves and a
 * sunset. With a face, the frame stops being the authority — a person standing
 * against a bright window is a correctly exposed photograph of an
 * underexposed subject, and no reading of the whole frame can say so.
 *
 * What it will not do is aim the skin at a lightness. How light skin is, is
 * what the person looks like. The only tonal judgement made from the face is a
 * comparison against its own surroundings, which is a statement about the
 * lighting.
 */

import type { FaceParams, GlobalParams } from '../recipe/schema';
import type { FaceStats, RenderStats } from '../render/pipeline';

/** Mid-grey as it lands in a display-referred histogram. */
const TARGET_MEAN = 0.46;

/**
 * How far the skin has to sit below its surroundings to count as backlit.
 *
 * In Oklab lightness, which is close enough to perceptual that the number means
 * what it looks like. Below this a face is simply a face in a scene; above it
 * the frame's exposure is being set by whatever is behind the person.
 */
const BACKLIT_MARGIN = 0.18;

/** And the same the other way, for a face lit much harder than its scene. */
const SPOTLIT_MARGIN = 0.22;

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
  | { kind: 'balanced' }
  /** No face was found, so the frame was treated as the subject. */
  | { kind: 'scene' }
  | { kind: 'faces'; count: number }
  | { kind: 'backlit' }
  | { kind: 'spotlit' }
  | { kind: 'uneven'; percent: number }
  | { kind: 'shine'; percent: number };

export interface AutoSuggestion {
  params: Partial<GlobalParams>;
  /** Empty whenever there was no face to measure. */
  face: Partial<FaceParams>;
  notes: AutoNote[];
}

/**
 * Derive a starting grade from a measurement of the untouched image.
 *
 * @param stats Must come from a neutral recipe: measuring the already-graded
 * result would fold the previous suggestion back into the next one.
 * @param face The same, measured inside the skin mask. Null when the photo has
 * no face in it, the analysis has not finished, or it could not run at all —
 * all three mean the same thing here, which is that the frame is the subject.
 */
export function suggestGrade(stats: RenderStats, face: FaceStats | null = null): AutoSuggestion {
  const notes: AutoNote[] = [];
  const params: Partial<GlobalParams> = {};

  // Display-referred ratios are roughly the 2.2-th root of the light ratio, so
  // the correction is scaled back up into stops before becoming a slider value.
  const stops = 2.2 * Math.log2(TARGET_MEAN / Math.max(stats.meanLuma, 0.02));
  let exposure = clamp(stops / 3, -0.6, 0.6);

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

  let highlights = stats.highlightClip > 0.02 ? clamp(-stats.highlightClip * 6, -0.6, 0) : 0;
  let shadows = stats.shadowClip > 0.04 ? clamp(stats.shadowClip * 4, 0, 0.5) : 0;
  if (highlights < 0) notes.push({ kind: 'highlightClip', percent: stats.highlightClip * 100 });
  if (shadows > 0) notes.push({ kind: 'shadowClip', percent: stats.shadowClip * 100 });

  if (face === null) {
    // No face: the frame is the subject. Saturation is lifted through vibrance
    // and left unprotected, because the hues a face would need holding back
    // from are the same ones a sunset lives in.
    params.vibrance = 0.18;
    notes.push({ kind: 'scene' });
  } else {
    notes.push({ kind: 'faces', count: face.faceCount });
    // Vibrance rather than saturation, and with skin protection on: a global
    // colour lift is what turns faces red, and these two are what stop it.
    params.vibrance = 0.14;
    params.skinHueProtect = 0.8;

    const against = face.surroundLightness - face.skinLightness;
    if (against > BACKLIT_MARGIN) {
      // The exposure was set by the background. Opening the shadows is the part
      // of the correction that reaches the person without moving the rest of
      // the frame, so most of it goes there and only some into exposure.
      const recover = clamp((against - BACKLIT_MARGIN) * 1.8, 0, 0.45);
      shadows = Math.max(shadows, recover);
      exposure = clamp(exposure + recover * 0.4, -0.6, 0.6);
      notes.push({ kind: 'backlit' });
    } else if (-against > SPOTLIT_MARGIN) {
      // A face lit much harder than its scene: the highlights on it are the
      // ones about to go, and the frame's own clipping reading will not see it
      // coming because the face is a small part of the frame.
      highlights = Math.min(highlights, clamp(-(-against - SPOTLIT_MARGIN) * 1.2, -0.5, 0));
      notes.push({ kind: 'spotlit' });
    }

    const smooth = smoothFor(face);
    if (smooth > 1e-3) {
      notes.push({ kind: 'uneven', percent: face.unevenness * 100 });
      // Smoothing takes texture off the skin, and putting some back is the
      // difference between skin and plastic. Tying the default to the amount of
      // smoothing means the common case avoids the failure without anyone
      // having to know it exists.
      params.grain = { amount: clamp(smooth * 0.4, 0, 0.22), size: 1 };
    }
    if (face.specular > 0.04) notes.push({ kind: 'shine', percent: face.specular * 100 });
  }

  if (Math.abs(exposure) > 0.02) {
    params.exposure = exposure;
    notes.push({ kind: 'exposure', stops });
  }
  if (highlights < 0) params.highlights = highlights;
  if (shadows > 0) params.shadows = shadows;

  const suggestion = face === null ? {} : suggestFace(face);
  // Counted rather than inferred from whether there are any notes at all: with
  // a face there is always at least the one saying so, and a photo that needed
  // nothing doing to it should still be told that it needed nothing doing.
  const corrected =
    params.exposure !== undefined ||
    params.highlights !== undefined ||
    params.shadows !== undefined ||
    params.blacks !== undefined ||
    params.whites !== undefined ||
    Object.keys(suggestion).length > 0;
  if (!corrected) notes.push({ kind: 'balanced' });

  return { params, face: suggestion, notes };
}

/**
 * How much smoothing the skin asks for.
 *
 * Deliberately short of what the measurement would justify. The suggestion is a
 * starting point somebody pushes further if they want to, and a first press
 * that has already gone too far is worse than one that has not gone far enough
 * — the second is an invitation, the first is something to undo.
 */
function smoothFor(face: FaceStats): number {
  return clamp((face.unevenness - 0.12) * 1.4, 0, 0.5);
}

/** The face block, from what the skin actually looks like. */
function suggestFace(face: FaceStats): Partial<FaceParams> {
  const out: Partial<FaceParams> = {};
  const smooth = smoothFor(face);
  if (smooth > 1e-3) out.smooth = smooth;

  const blemish = clamp((face.unevenness - 0.2) * 1.2, 0, 0.4);
  if (blemish > 1e-3) out.blemish = blemish;

  const shine = clamp((face.specular - 0.04) * 4, 0, 0.5);
  if (shine > 1e-3) out.shine = shine;

  return out;
}
