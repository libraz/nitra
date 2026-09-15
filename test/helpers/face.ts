/**
 * A synthetic face: ellipses where a real one has features.
 *
 * Shared rather than written per test file. Everything keyed to a face —
 * regions, coverage masks, reshaping — is checked against a face whose geometry
 * is known, and a second copy of this builder is one that drifts from the first
 * while both suites stay green.
 *
 * Laid out in the same isotropic units the geometry works in and converted back
 * to the model's normalised box on the way out, so a non-square frame exercises
 * the conversion rather than hiding it.
 */

import { CONTOURS } from '../../src/core/face/contours';
import type { NormalisedLandmark, Point } from '../../src/core/face/geometry';

export interface FaceShape {
  /** Centre of the head, in image-width units. */
  centre?: Point;
  /** Width of the head, in image-width units. */
  width?: number;
  /** Tilt, in radians, clockwise. */
  rotation?: number;
  /** Image height over image width. */
  aspect?: number;
}

export function makeFace({
  centre = { x: 0.5, y: 0.5 },
  width = 0.3,
  rotation = 0,
  aspect = 1,
}: FaceShape = {}): NormalisedLandmark[] {
  const landmarks: NormalisedLandmark[] = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const put = (index: number, x: number, y: number) => {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    landmarks[index] = { x: centre.x + rx, y: (centre.y + ry) / aspect };
  };

  const ellipse = (indices: readonly number[], cx: number, cy: number, rx: number, ry: number) => {
    indices.forEach((index, i) => {
      const angle = (i / indices.length) * Math.PI * 2;
      put(index, cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry);
    });
  };

  // Semi-axes chosen so the outline's area is the canonical proportion of its
  // own width squared, which is what the width is recovered from.
  ellipse(CONTOURS.faceOval, 0, 0, width / 2, width * 0.7);
  ellipse(CONTOURS.leftEye, -width * 0.22, -width * 0.12, width * 0.09, width * 0.045);
  ellipse(CONTOURS.rightEye, width * 0.22, -width * 0.12, width * 0.09, width * 0.045);
  ellipse(CONTOURS.leftBrow, -width * 0.22, -width * 0.24, width * 0.11, width * 0.02);
  ellipse(CONTOURS.rightBrow, width * 0.22, -width * 0.24, width * 0.11, width * 0.02);
  // Wider than the eye opening is tall, which is what an iris is: the lid
  // covers the top and the bottom of it.
  ellipse(CONTOURS.leftIris, -width * 0.22, -width * 0.12, width * 0.05, width * 0.05);
  ellipse(CONTOURS.rightIris, width * 0.22, -width * 0.12, width * 0.05, width * 0.05);
  ellipse(CONTOURS.lips[0] ?? [], 0, width * 0.28, width * 0.14, width * 0.07);
  ellipse(CONTOURS.lips[1] ?? [], 0, width * 0.28, width * 0.09, width * 0.03);
  return landmarks;
}

/** How far a point lies along an axis from a centre. */
export function along(point: Point, from: Point, axis: Point): number {
  return (point.x - from.x) * axis.x + (point.y - from.y) * axis.y;
}

/** Whether a point is inside a polygon, by crossing count. */
export function inside(polygon: readonly Point[], point: Point): boolean {
  let crossings = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    if (a.y === b.y) continue;
    if (point.y < Math.min(a.y, b.y) || point.y >= Math.max(a.y, b.y)) continue;
    const x = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (x > point.x) crossings++;
  }
  return crossings % 2 === 1;
}
