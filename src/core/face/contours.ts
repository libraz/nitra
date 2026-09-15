/**
 * Which of the 478 landmarks bound which part of a face.
 *
 * The index lists are not written out here. They are derived from the
 * connection sets the landmark model publishes alongside itself, so the
 * outline of an eye is whatever that model says it is rather than a row of
 * integers that has to be checked against it by hand — a wrong index is a
 * smoothing that leaks over an eyelid, and it would look like a shader bug.
 *
 * Importing the model's module for these costs nothing: the constants are plain
 * arrays and no inference runtime is loaded until a task is created.
 *
 * One part the design asks for has no published set: the nostril rims. Rather
 * than guess at indices, the skin stage keeps dark detail out of the smoothed
 * result by its own edge response, which is what the nostril polygon was there
 * to achieve.
 */

import { FaceLandmarker } from '@mediapipe/tasks-vision';

export interface Connection {
  start: number;
  end: number;
}

/** A chain of landmark indices. `closed` rings come back without a repeat. */
export interface LandmarkPath {
  indices: number[];
  closed: boolean;
}

/**
 * Chain a set of edges into the paths it describes.
 *
 * A connection set is an undirected edge list with no ordering promise, and the
 * sets differ in shape: an eye is one closed ring, the lips are two, and a brow
 * is a pair of open lines along its edges. Splitting by connected component and
 * deciding closed-ness from the degrees covers all three without the caller
 * having to know which it asked for.
 */
export function pathsFromConnections(connections: readonly Connection[]): LandmarkPath[] {
  const neighbours = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    const list = neighbours.get(a);
    if (list) list.push(b);
    else neighbours.set(a, [b]);
  };
  for (const { start, end } of connections) {
    link(start, end);
    link(end, start);
  }

  const seen = new Set<number>();
  const paths: LandmarkPath[] = [];

  const walk = (from: number): number[] => {
    const chain = [from];
    seen.add(from);
    let current = from;
    for (;;) {
      const next = (neighbours.get(current) ?? []).find((n) => !seen.has(n));
      if (next === undefined) return chain;
      seen.add(next);
      chain.push(next);
      current = next;
    }
  };

  // Open paths are walked from an end, so the chain comes out in order along
  // the line rather than starting in its middle and stopping short.
  for (const [vertex, list] of neighbours) {
    if (list.length === 1 && !seen.has(vertex))
      paths.push({ indices: walk(vertex), closed: false });
  }
  for (const vertex of neighbours.keys()) {
    if (!seen.has(vertex)) paths.push({ indices: walk(vertex), closed: true });
  }

  return paths;
}

/** The single closed ring a connection set describes. */
function ring(connections: readonly Connection[], what: string): number[] {
  const paths = pathsFromConnections(connections);
  const closed = paths.filter((path) => path.closed);
  const only = closed[0];
  if (closed.length !== 1 || !only) {
    throw new Error(`${what}: expected one closed ring, found ${closed.length}`);
  }
  return only.indices;
}

/** Every landmark a connection set touches, in no particular order. */
function vertices(connections: readonly Connection[]): number[] {
  const all = new Set<number>();
  for (const { start, end } of connections) {
    all.add(start);
    all.add(end);
  }
  return [...all];
}

/**
 * The landmark indices each part is read from.
 *
 * Eyes, the face outline and the lips come out as closed rings and are used as
 * polygons directly. A brow is published as the two lines along its edges, so
 * it is carried as a bare point set and closed by its convex hull, which is
 * both simpler and safer: a brow has to be excluded from the skin with room to
 * spare, and a hull errs in that direction.
 */
export const CONTOURS = {
  faceOval: ring(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, 'face oval'),
  leftEye: ring(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, 'left eye'),
  rightEye: ring(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, 'right eye'),
  leftBrow: vertices(FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW),
  rightBrow: vertices(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW),
  /**
   * Both lip rings, in the order the model lists them.
   *
   * Which is the outer one is decided from the landmarks themselves rather than
   * from an index: the two rings are the same size, so there is nothing here
   * that could tell them apart.
   */
  lips: pathsFromConnections(FaceLandmarker.FACE_LANDMARKS_LIPS)
    .filter((path) => path.closed)
    .map((path) => path.indices),
  /**
   * The rim of each iris: four points at its extremes.
   *
   * These are the only landmarks that come from the model's refinement pass
   * rather than from its mesh, so they are the only ones that can be absent. A
   * build served a model without them gets 468 points instead of 478, and
   * `faceRegions` treats the irises as not found rather than failing — which
   * leaves the two iris controls doing nothing, the same as they do on a photo
   * with no face in it.
   */
  leftIris: ring(FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, 'left iris'),
  rightIris: ring(FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, 'right iris'),
} as const;
