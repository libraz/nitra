/**
 * Landmarks to the regions the picture stages act on.
 *
 * Everything here is measured in units of the image's width, not in pixels and
 * not in the anisotropic 0..1 box the model returns. Two things follow from
 * that, and both are the point of doing it. Distances are isotropic, so a
 * radius is a circle on a photo that is not square. And every amount stays a
 * fraction of the face rather than a pixel count, so the same recipe means the
 * same thing on the next photo, at the next resolution, with the face at the
 * next size — which is what makes presets and batch application possible at
 * all.
 *
 * No GPU and no model runtime is involved, so all of it is testable directly.
 */

import { CONTOURS } from './contours';

export interface Point {
  x: number;
  y: number;
}

/** A landmark as the model returns it: normalised against the image box. */
export interface NormalisedLandmark {
  x: number;
  y: number;
}

/** A soft-edged disc, which is what a blusher is and a polygon is not. */
export interface Disc {
  centre: Point;
  radius: number;
  /** Width of the falloff, in the same units as the radius. */
  feather: number;
}

export interface FaceRegions {
  /** The outline of the face. */
  oval: Point[];
  /** Everything smoothing has to stay off: eyelids, brows, lips. */
  features: Point[][];
  /** The lips themselves, for colour. */
  lips: Point[];
  /** Inside the lips — teeth when the mouth is open. */
  mouth: Point[];
  /** The eye openings, where the white of the eye is. */
  sclera: Point[][];
  /** The band under each eye. */
  undereye: Point[][];
  cheeks: Disc[];
  /**
   * The irises, as circles. Empty when the model did not return them.
   *
   * Two rather than one per eye is not assumed anywhere: the stages read a
   * coverage channel, so a face turned far enough that only one iris was found
   * is a face with one iris in it.
   */
  irises: Disc[];
  /**
   * The width of the face, in image-width units.
   *
   * Every radius in the pipeline is a fraction of this.
   */
  width: number;
  /** Centre of the face outline. */
  centre: Point;
  /**
   * The face's own axes: unit vectors along the eyes and down towards the mouth.
   *
   * Carried rather than re-derived by whoever needs them. Reshaping has to know
   * which way is sideways on this face, and a second derivation of the same two
   * vectors is one that drifts from this one unnoticed. They are not exactly
   * perpendicular — the eye line and the eyes-to-mouth line are measured
   * separately and a turned head skews them, which is the information a
   * reshaping needs rather than a defect to be orthogonalised away.
   */
  axes: FaceAxes;
}

export interface FaceAxes {
  /** Towards the face's own right, which is the viewer's left. */
  right: Point;
  /** From the eyes towards the mouth. */
  down: Point;
}

/**
 * Area of the canonical face outline, in units of its own width squared.
 *
 * Deriving the width from the area rather than from a bounding box is what
 * makes it survive a tilted head: a box around a face rotated by thirty degrees
 * is half again too wide, and every radius keyed to it would grow with the
 * tilt.
 */
const OVAL_AREA_RATIO = 1.1;

/** How far the feature exclusions are grown, as a fraction of the face width. */
const FEATURE_MARGIN = 0.012;

/**
 * Softness of the iris edge, as a fraction of its own radius.
 *
 * Narrow on purpose. The limbus is the sharpest edge in an eye, and the work
 * done inside this region is local contrast — a wide falloff would spread it
 * onto the white of the eye, where the same operation reads as a dirty sclera.
 */
const IRIS_FEATHER = 0.2;

export function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point;
    const b = points[(i + 1) % points.length] as Point;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function centroid(points: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, points.length);
  return { x: x / n, y: y / n };
}

/**
 * Grow a polygon outwards from its own centre.
 *
 * Offsetting an outline properly means mitring every corner and dealing with
 * the ones that cross; pushing each vertex along its radius does the same job
 * for the shapes this is used on, all of which are blobs seen from inside.
 */
export function dilate(points: readonly Point[], amount: number): Point[] {
  const c = centroid(points);
  return points.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return { x: p.x, y: p.y };
    return { x: p.x + (dx / len) * amount, y: p.y + (dy / len) * amount };
  });
}

/** Convex hull, counter-clockwise, by monotone chain. */
export function convexHull(points: readonly Point[]): Point[] {
  if (points.length < 3) return points.map((p) => ({ x: p.x, y: p.y }));
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const half = (input: readonly Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of input) {
      while (
        out.length >= 2 &&
        cross(out[out.length - 2] as Point, out[out.length - 1] as Point, p) <= 0
      ) {
        out.pop();
      }
      out.push({ x: p.x, y: p.y });
    }
    return out;
  };

  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function pick(
  landmarks: readonly NormalisedLandmark[],
  indices: readonly number[],
  aspect: number,
): Point[] {
  return indices.map((i) => {
    const l = landmarks[i];
    if (!l) throw new Error(`landmark ${i} is missing`);
    return { x: l.x, y: l.y * aspect };
  });
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function normalise(p: Point): Point {
  const len = Math.hypot(p.x, p.y);
  if (len < 1e-9) return { x: 0, y: 0 };
  return { x: p.x / len, y: p.y / len };
}

function add(a: Point, scaled: Point, k: number): Point {
  return { x: a.x + scaled.x * k, y: a.y + scaled.y * k };
}

/** How far a ring reaches along an axis, from its own centre. */
function halfExtent(points: readonly Point[], centre: Point, axis: Point): number {
  let max = 0;
  for (const p of points) {
    const d = sub(p, centre);
    max = Math.max(max, Math.abs(d.x * axis.x + d.y * axis.y));
  }
  return max;
}

/**
 * The band under one eye.
 *
 * Built from the eye's own axes rather than from image coordinates, so it stays
 * under the eye on a head that is tilted. It narrows towards the bottom because
 * the shadow it is there to lift does: a rectangle would reach onto the cheek
 * on the outer side and onto the nose on the inner one.
 */
function undereyeBand(
  eye: readonly Point[],
  right: Point,
  down: Point,
  faceWidth: number,
): Point[] {
  const c = centroid(eye);
  const halfWidth = halfExtent(eye, c, right) * 1.05;
  const top = add(c, down, halfExtent(eye, c, down) + faceWidth * 0.015);
  const bottom = add(top, down, faceWidth * 0.1);
  return [
    add(top, right, -halfWidth),
    add(top, right, halfWidth),
    add(bottom, right, halfWidth * 0.8),
    add(bottom, right, -halfWidth * 0.8),
  ];
}

/**
 * The iris as a circle, fitted to the four points around its rim.
 *
 * Fitted rather than filled as a polygon, because a quadrilateral through four
 * points on a circle encloses under two thirds of it: a third of every iris
 * would sit outside the region, in a ring, which is the one place a local
 * contrast must not stop abruptly. Four points are exactly enough to fit a
 * circle to, and an iris is a circle.
 */
function irisDisc(rim: readonly Point[]): Disc {
  const centre = centroid(rim);
  const radius =
    rim.reduce((sum, p) => sum + Math.hypot(p.x - centre.x, p.y - centre.y), 0) /
    Math.max(rim.length, 1);
  return { centre, radius, feather: radius * IRIS_FEATHER };
}

/**
 * Resolve one face's landmarks into the regions the stages need.
 *
 * @param aspect Image height divided by its width, which is what turns the
 * model's normalised coordinates into the isotropic units everything else here
 * is measured in.
 */
export function faceRegions(landmarks: readonly NormalisedLandmark[], aspect: number): FaceRegions {
  const oval = pick(landmarks, CONTOURS.faceOval, aspect);
  const width = Math.sqrt(polygonArea(oval) / OVAL_AREA_RATIO);
  const margin = width * FEATURE_MARGIN;

  const leftEye = pick(landmarks, CONTOURS.leftEye, aspect);
  const rightEye = pick(landmarks, CONTOURS.rightEye, aspect);
  const brows = [CONTOURS.leftBrow, CONTOURS.rightBrow].map((indices) =>
    convexHull(pick(landmarks, indices, aspect)),
  );

  // The two lip rings are the same size, so the outer one is the one that
  // encloses more area. There is nothing in the index lists that says which.
  const lipRings = CONTOURS.lips
    .map((indices) => pick(landmarks, indices, aspect))
    .sort((a, b) => polygonArea(b) - polygonArea(a));
  const lips = lipRings[0] ?? [];
  const mouth = lipRings[1] ?? [];

  const eyesCentre = centroid([...leftEye, ...rightEye]);
  const down = normalise(sub(centroid(lips), eyesCentre));
  const right = normalise(sub(centroid(rightEye), centroid(leftEye)));
  const centre = centroid(oval);

  // The iris landmarks are the model's refinement rather than its mesh, so they
  // are the one part of this that can simply be missing.
  const irises = [CONTOURS.leftIris, CONTOURS.rightIris]
    .filter((indices) => indices.every((i) => landmarks[i] !== undefined))
    .map((indices) => irisDisc(pick(landmarks, indices, aspect)));

  const cheeks: Disc[] = [leftEye, rightEye].map((eye) => {
    const eyeCentre = centroid(eye);
    const below = add(eyeCentre, down, width * 0.3);
    // Pushed away from the middle of the face, which is where a cheek is.
    const outward = normalise(sub(eyeCentre, eyesCentre));
    return {
      centre: add(below, outward, width * 0.05),
      radius: width * 0.15,
      feather: width * 0.12,
    };
  });

  return {
    oval,
    features: [
      dilate(leftEye, margin),
      dilate(rightEye, margin),
      ...brows.map((brow) => dilate(brow, margin)),
      dilate(lips, margin),
    ],
    lips,
    mouth,
    sclera: [leftEye, rightEye],
    undereye: [
      undereyeBand(leftEye, right, down, width),
      undereyeBand(rightEye, right, down, width),
    ],
    cheeks,
    irises,
    width,
    centre,
    axes: { right, down },
  };
}
