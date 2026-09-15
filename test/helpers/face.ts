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

import { CONTOURS, type Connection, type Triangle } from '../../src/core/face/contours';
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
  /**
   * How far the middle of the head comes towards the camera, in width units.
   *
   * Zero is a flat face, which is not a shape any head has and is exactly what
   * a normal field should report as facing straight forward.
   */
  relief?: number;
  /** How far the nose comes forward on top of that. */
  nose?: number;
}

/**
 * The model's depth at a point on the synthetic head.
 *
 * An ellipsoid bulging towards the camera, with a ridge down the middle. Signed
 * the way the model signs it — towards the camera is *smaller* — so a test that
 * gets the direction of the relief backwards fails here rather than agreeing
 * with a shader that has the same mistake.
 */
function surfaceDepth(x: number, y: number, width: number, relief: number, nose: number): number {
  const radial = Math.hypot(x / (width / 2), y / (width * 0.7));
  const dome = radial < 1 ? Math.sqrt(1 - radial * radial) : 0;
  // Narrow across and tapering away above the brow and below the tip.
  const ridge = Math.exp(-((x / (width * 0.08)) ** 2)) * Math.exp(-((y / (width * 0.22)) ** 2));
  return -(dome * relief + ridge * nose);
}

/**
 * The interior mesh's grid, which is what makes the synthetic head a surface.
 *
 * A grid rather than a scatter because its triangulation is known without
 * computing one, and computing one here would mean a second implementation of
 * the thing under test.
 *
 * It is laid over the indices the named contours do not use. A contour point is
 * moved onto its own ellipse afterwards, and a vertex that moves out from under
 * its triangles is a fold in the surface; leaving them out makes them landmarks
 * on the mesh rather than corners of it. There are exactly this many free, which
 * is where the shape of the grid comes from.
 */
const MESH_COLS = 17;
const MESH_ROWS = 20;

/** The landmark indices the grid is laid over, in ascending order. */
const GRID: readonly number[] = (() => {
  const taken = new Set(Object.values(CONTOURS).flat(2) as number[]);
  const free: number[] = [];
  for (let index = 0; index < 468 && free.length < MESH_COLS * MESH_ROWS; index++) {
    if (!taken.has(index)) free.push(index);
  }
  return free;
})();

function at(row: number, col: number): number {
  return GRID[row * MESH_COLS + col] as number;
}

function ascending(a: number, b: number, c: number): Triangle {
  const [p, q, r] = [a, b, c].sort((one, other) => one - other) as [number, number, number];
  return [p, q, r];
}

/** The grid's own triangulation: the two triangles either side of each cell's diagonal. */
export function meshTriangles(): Triangle[] {
  const triangles: Triangle[] = [];
  for (let row = 0; row + 1 < MESH_ROWS; row++) {
    for (let col = 0; col + 1 < MESH_COLS; col++) {
      const topLeft = at(row, col);
      const bottomRight = at(row + 1, col + 1);
      triangles.push(ascending(topLeft, at(row, col + 1), bottomRight));
      triangles.push(ascending(topLeft, bottomRight, at(row + 1, col)));
    }
  }
  return triangles;
}

/**
 * The same triangulation as the edge list a model publishes it as.
 *
 * Both directions of every edge, including the ones along the border, because
 * that is the shape the recovery has to cope with: a published tessellation
 * carries no winding to read.
 */
export function meshConnections(): Connection[] {
  const edges = new Set<string>();
  for (const [a, b, c] of meshTriangles()) {
    for (const [start, end] of [
      [a, b],
      [a, c],
      [b, c],
    ]) {
      edges.add(`${start},${end}`);
    }
  }
  return [...edges].flatMap((edge) => {
    const [start, end] = edge.split(',').map(Number) as [number, number];
    return [
      { start, end },
      { start: end, end: start },
    ];
  });
}

export function makeFace({
  centre = { x: 0.5, y: 0.5 },
  width = 0.3,
  rotation = 0,
  aspect = 1,
  relief = width * 0.25,
  nose = width * 0.06,
}: FaceShape = {}): NormalisedLandmark[] {
  const landmarks: NormalisedLandmark[] = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const put = (index: number, x: number, y: number) => {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    landmarks[index] = {
      x: centre.x + rx,
      y: (centre.y + ry) / aspect,
      // Depth is a property of the head, so it is taken before the tilt: a face
      // leaning sideways has the same nose.
      z: surfaceDepth(x, y, width, relief, nose),
    };
  };

  // The mesh, before the named contours are placed on top of it. The stages
  // that read outlines only ever touch the contour indices, but the normals are
  // built from the triangles between these, and points left at the origin would
  // put the whole head's worth of surface in the corner of the picture.
  //
  // The square grid is mapped onto the ellipse rather than clipped to it, so
  // every cell stays a quad and the mesh has no ragged edge for the coverage to
  // inherit.
  for (let row = 0; row < MESH_ROWS; row++) {
    for (let col = 0; col < MESH_COLS; col++) {
      const u = (col / (MESH_COLS - 1)) * 2 - 1;
      const v = (row / (MESH_ROWS - 1)) * 2 - 1;
      put(
        at(row, col),
        u * Math.sqrt(1 - (v * v) / 2) * (width / 2),
        v * Math.sqrt(1 - (u * u) / 2) * (width * 0.7),
      );
    }
  }

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
