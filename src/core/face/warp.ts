/**
 * Reshaping: the sliders, resolved into a displacement field.
 *
 * The field is described as a small set of control points rather than evaluated
 * here. Each one says "this bit of the face moves that way, and the move fades
 * out over this distance", and the renderer sums them per pixel. Splitting it
 * there keeps the part with the geometry and the sign conventions in TypeScript,
 * where it is testable without a GPU, and leaves the per-pixel work on the GPU,
 * where it belongs.
 *
 * Two conventions hold throughout, and getting either backwards is the kind of
 * bug that looks like a broken shader.
 *
 * Coordinates are in units of the image's width, as everywhere else in this
 * directory: x is the normalised horizontal coordinate and y is the normalised
 * vertical one multiplied by the aspect. Distances are therefore isotropic, so a
 * radius is a circle on a photograph that is not square.
 *
 * A control point's `delta` is **where the face goes**, not where to read from.
 * Resampling needs the opposite of that, and the negation happens once, in the
 * shader that builds the field. Anything that reads a delta here is reading the
 * motion a person would describe.
 */

import type { FaceParams } from '../recipe/schema';
import { centroid, type FaceRegions, type Point } from './geometry';

/**
 * One local displacement.
 *
 * The support is compact: outside `radius` the point contributes nothing. That
 * is what pins the photograph's border, which the design requires — a warp that
 * reached the edge of the frame would bend the straight lines of a doorway, and
 * that reads as damage rather than as retouching.
 */
export interface ControlPoint {
  /** Where the displacement is centred. */
  centre: Point;
  /** How far and which way the face moves here. */
  delta: Point;
  /** Distance over which the displacement falls to nothing. */
  radius: number;
}

/**
 * How far a slider at one moves the face, as a fraction of its width.
 *
 * These are the only absolute numbers in the reshaping, and they are the ones
 * that decide whether the top of a slider is a retouch or a caricature. They
 * are set from anatomical proportion and have not been calibrated against a
 * measured preference, so they are a starting point: the amount is right when
 * the top of the slider is clearly too much and three quarters of it is not.
 */
const REACH = {
  /** Half the narrowing at the widest part of the outline. */
  faceSlim: 0.06,
  /** Additional inward pull along the jaw, on top of any slimming. */
  jawline: 0.045,
  chin: 0.05,
  /** Fraction of the eye's own radius the opening grows by. */
  eyeEnlarge: 0.12,
  eyeTilt: 0.03,
  noseNarrow: 0.025,
  noseBridge: 0.02,
  mouthWidth: 0.03,
} as const;

/**
 * Ceiling on any one displacement, as a fraction of the face width.
 *
 * Several sliders act on the same part of a face — slimming and the jawline
 * both pull the lower outline inwards — and nothing stops a person from raising
 * all of them. This is the guardrail the design asks for, applied where the
 * displacement is decided rather than left to the sliders to avoid between
 * them: past this much the outline crosses features that are not moving with
 * it, and the result is not a narrower face but a damaged one.
 */
const MAX_DISPLACEMENT = 0.08;

/**
 * How many control points the renderer will take.
 *
 * Set by what a fragment shader is guaranteed to be able to hold, not by what
 * the reshaping would like. Each point is two `vec4` uniforms, and the floor
 * every WebGL2 implementation promises is 224 of those — so 64 points is 128
 * vectors and leaves room for everything else the pass needs, while 128 points
 * would work on the machine it was written on and fail on someone's phone.
 *
 * The shader's loop is bounded by this same number, so it is not a budget that
 * can be quietly exceeded: a point past it would not be summed, and the part of
 * the face it described would stay where it was while its neighbours moved.
 * {@link warpControlPoints} therefore allocates against it rather than
 * truncating.
 */
export const MAX_CONTROL_POINTS = 64;

/**
 * Points each face needs before its outline gets any.
 *
 * The eyes, an eye corner each side, the chin, the nose and the corners of the
 * mouth. Fixed per face, which is what the outline's share is measured against.
 */
const FIXED_PER_FACE = 16;

/** Ring points per eye when the eyes are being opened. */
const EYE_RING = 4;

/** Anatomical proportions, as fractions of the eyes-to-mouth distance. */
const NOSE_BASE = 0.62;
const NOSE_BRIDGE = 0.3;

/** Half-width of the nose, as a fraction of the face width. */
const NOSE_HALF_WIDTH = 0.17;

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: Point, direction: Point, k: number): Point {
  return { x: a.x + direction.x * k, y: a.y + direction.y * k };
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

function length(p: Point): number {
  return Math.hypot(p.x, p.y);
}

function scale(p: Point, k: number): Point {
  return { x: p.x * k, y: p.y * k };
}

/** Clamp a displacement to the guardrail, keeping its direction. */
function limited(delta: Point, width: number): Point {
  const ceiling = width * MAX_DISPLACEMENT;
  const len = length(delta);
  return len <= ceiling ? delta : scale(delta, ceiling / len);
}

/** Mean distance from a ring to its own centre. */
function ringRadius(ring: readonly Point[], centre: Point): number {
  if (ring.length === 0) return 0;
  let total = 0;
  for (const p of ring) total += length(sub(p, centre));
  return total / ring.length;
}

/** The vertex of a ring that reaches furthest along an axis. */
function extreme(ring: readonly Point[], centre: Point, axis: Point): Point {
  let best = centre;
  let far = -Infinity;
  for (const p of ring) {
    const d = dot(sub(p, centre), axis);
    if (d > far) {
      far = d;
      best = p;
    }
  }
  return best;
}

/**
 * Every n-th vertex of a ring, at most `limit` of them.
 *
 * The outline arrives with more vertices than a displacement needs: the field
 * is smooth over distances of a tenth of the face, so describing it at every
 * one of thirty-six points spends the budget without changing the picture.
 */
function thinned(ring: readonly Point[], limit: number): Point[] {
  if (ring.length <= limit) return [...ring];
  const step = ring.length / limit;
  const out: Point[] = [];
  for (let i = 0; i < limit; i++) out.push(ring[Math.floor(i * step)] as Point);
  return out;
}

/**
 * The outline moving inwards: slimming, and the jaw.
 *
 * Each vertex is pulled towards the face's own midline by an amount
 * proportional to how far out it already is, so the widest part moves most and
 * the chin, which is on the midline, is not dragged sideways. The jaw term adds
 * to that over the lower half only, which is what separates "a narrower face"
 * from "a narrower jaw" — the same pull applied everywhere just scales the
 * face down.
 */
function outlinePoints(
  face: FaceRegions,
  warp: FaceParams['warp'],
  budget: number,
): ControlPoint[] {
  if (warp.faceSlim < 1e-4 && warp.jawline < 1e-4) return [];
  const { width, centre, axes } = face;
  const half = width / 2;
  const points: ControlPoint[] = [];

  for (const p of thinned(face.oval, budget)) {
    const offset = sub(p, centre);
    const lateral = dot(offset, axes.right) / half;
    // Zero above the eye line, one at the bottom of the outline.
    const lower = Math.min(1, Math.max(0, dot(offset, axes.down) / half));
    // Negated, so the pull is towards the midline whichever side of it this
    // vertex is on, and proportional, so the widest part of the outline moves
    // most and the chin is not dragged sideways.
    const amount =
      width * (warp.faceSlim * REACH.faceSlim + warp.jawline * REACH.jawline * lower) * -lateral;
    if (Math.abs(amount) < 1e-6) continue;
    points.push({
      centre: p,
      delta: limited(scale(axes.right, amount), width),
      // Wide enough that neighbouring vertices overlap, which is what makes the
      // outline move as an outline rather than as a row of dents.
      radius: width * 0.18,
    });
  }
  return points;
}

/** The chin, shortened or lengthened along the face's own vertical. */
function chinPoint(face: FaceRegions, warp: FaceParams['warp']): ControlPoint[] {
  if (Math.abs(warp.chin) < 1e-4) return [];
  const { width, centre, axes } = face;
  const tip = extreme(face.oval, centre, axes.down);
  return [
    {
      centre: tip,
      delta: limited(scale(axes.down, -warp.chin * width * REACH.chin), width),
      radius: width * 0.3,
    },
  ];
}

/**
 * The eyes: opened outwards, and tilted at the outer corner.
 *
 * Opening is a ring of points all pushed away from the eye's own centre. The
 * centre itself does not move, because the displacements around it cancel — an
 * eye that grows rather than an eye that slides.
 */
function eyePoints(face: FaceRegions, warp: FaceParams['warp'], budget: number): ControlPoint[] {
  if (warp.eyeEnlarge < 1e-4 && Math.abs(warp.eyeTilt) < 1e-4) return [];
  const { width, centre: faceCentre, axes } = face;
  const points: ControlPoint[] = [];

  for (const eye of face.sclera) {
    const eyeCentre = centroid(eye);
    const radius = ringRadius(eye, eyeCentre);
    if (radius < 1e-6) continue;

    if (warp.eyeEnlarge >= 1e-4) {
      const grow = radius * warp.eyeEnlarge * REACH.eyeEnlarge;
      for (const p of thinned(eye, budget)) {
        const out = sub(p, eyeCentre);
        const len = length(out);
        if (len < 1e-9) continue;
        points.push({
          centre: p,
          delta: limited(scale(out, grow / len), width),
          radius: radius * 1.6,
        });
      }
    }

    if (Math.abs(warp.eyeTilt) >= 1e-4) {
      // Away from the middle of the face, which is where the corner that reads
      // as a tilt is. The inner corner staying put is what makes it a tilt.
      const side = dot(sub(eyeCentre, faceCentre), axes.right) >= 0 ? 1 : -1;
      const outward = scale(axes.right, side);
      points.push({
        centre: extreme(eye, eyeCentre, outward),
        delta: limited(scale(axes.down, -warp.eyeTilt * width * REACH.eyeTilt), width),
        radius: radius * 2,
      });
    }
  }
  return points;
}

/**
 * The nose, positioned from the face's own axes rather than from its outline.
 *
 * The landmark model publishes no nose contour, and `contours.ts` refuses to
 * guess at indices for the same reason it refuses for the nostrils: a wrong
 * index is a retouch in the wrong place that reads as a shader bug. What it does
 * publish is enough — the eyes and the mouth give the axis the nose lies on and
 * the distance along it, and the proportions below place the alar base and the
 * bridge on that axis. They are anatomical averages, so this is the one part of
 * the reshaping that is positioned by proportion instead of by measurement.
 */
function nosePoints(face: FaceRegions, warp: FaceParams['warp']): ControlPoint[] {
  if (warp.noseNarrow < 1e-4 && Math.abs(warp.noseBridge) < 1e-4) return [];
  const { width, axes } = face;
  const eyes = centroid(face.sclera.flat());
  const mouth = centroid(face.lips);
  const span = length(sub(mouth, eyes));
  if (span < 1e-6) return [];
  const points: ControlPoint[] = [];

  if (warp.noseNarrow >= 1e-4) {
    const base = add(eyes, axes.down, span * NOSE_BASE);
    const reach = width * NOSE_HALF_WIDTH;
    for (const side of [1, -1]) {
      points.push({
        centre: add(base, axes.right, reach * side),
        delta: limited(
          scale(axes.right, -side * width * warp.noseNarrow * REACH.noseNarrow),
          width,
        ),
        radius: width * 0.14,
      });
    }
  }

  if (Math.abs(warp.noseBridge) >= 1e-4) {
    // Drawn up towards the brow, which is what straightens the line of the
    // bridge in a photograph. Height itself is not available to a warp: it can
    // only move pixels within the plane they were recorded in.
    points.push({
      centre: add(eyes, axes.down, span * NOSE_BRIDGE),
      delta: limited(scale(axes.down, -warp.noseBridge * width * REACH.noseBridge), width),
      radius: width * 0.2,
    });
  }
  return points;
}

/** The corners of the mouth, moved apart or together. */
function mouthPoints(face: FaceRegions, warp: FaceParams['warp']): ControlPoint[] {
  if (Math.abs(warp.mouthWidth) < 1e-4 || face.lips.length === 0) return [];
  const { width, axes } = face;
  const lipCentre = centroid(face.lips);
  return [1, -1].map((side) => {
    const corner = extreme(face.lips, lipCentre, scale(axes.right, side));
    return {
      centre: corner,
      delta: limited(scale(axes.right, side * width * warp.mouthWidth * REACH.mouthWidth), width),
      radius: width * 0.12,
    };
  });
}

/**
 * How many faces one reshaping can describe, and how finely.
 *
 * A face needs its fixed points plus enough of its outline to move as an
 * outline, so the budget decides how many faces fit rather than being spread
 * until none of them is described properly. Faces are taken largest first,
 * because the large one is the one being retouched.
 *
 * The count is returned rather than the excess being dropped quietly. A group
 * photo where the fourth person was not reshaped is something the panel can say;
 * a fourth person reshaped halfway, because the budget ran out partway through
 * their jaw, is not something anyone could read off the picture.
 */
export function warpBudget(faceCount: number): { faces: number; outline: number } {
  if (faceCount <= 0) return { faces: 0, outline: 0 };
  // At least four outline points, or the outline is not an outline.
  const most = Math.max(1, Math.floor(MAX_CONTROL_POINTS / (FIXED_PER_FACE + 4)));
  const faces = Math.min(faceCount, most);
  const outline = Math.floor(MAX_CONTROL_POINTS / faces) - FIXED_PER_FACE;
  return { faces, outline };
}

/** Every control point the current reshaping asks for, and what it covers. */
export interface WarpField {
  points: ControlPoint[];
  /** How many of the faces found are being reshaped. */
  faces: number;
  /** How many were left out because the field could not describe them. */
  omitted: number;
}

export function warpControlPoints(
  faces: readonly FaceRegions[],
  warp: FaceParams['warp'],
): WarpField {
  if (faces.length === 0) return { points: [], faces: 0, omitted: 0 };
  const budget = warpBudget(faces.length);
  const largest = [...faces].sort((a, b) => b.width - a.width).slice(0, budget.faces);
  const points: ControlPoint[] = [];
  for (const face of largest) {
    points.push(
      ...outlinePoints(face, warp, budget.outline),
      ...chinPoint(face, warp),
      ...eyePoints(face, warp, EYE_RING),
      ...nosePoints(face, warp),
      ...mouthPoints(face, warp),
    );
  }
  if (points.length > MAX_CONTROL_POINTS) {
    // The allocation above is what keeps this from happening. Reaching it means
    // a part's own point count grew past what the fixed share allows for, and
    // silently dropping the tail is the one outcome worth refusing.
    throw new Error(`reshaping asked for ${points.length} control points of ${MAX_CONTROL_POINTS}`);
  }
  return { points, faces: largest.length, omitted: faces.length - largest.length };
}

/**
 * The largest displacement in a field, as a fraction of the face width.
 *
 * Measured rather than predicted, like every other guardrail: what a person
 * needs to be told is how far the face actually moved, not what the sliders
 * were set to.
 */
export function warpMagnitude(points: readonly ControlPoint[], faceWidth: number): number {
  if (faceWidth < 1e-9) return 0;
  let most = 0;
  for (const p of points) most = Math.max(most, length(p.delta));
  return most / faceWidth;
}
