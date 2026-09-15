/**
 * The contours are derived from the landmark model's own connection sets rather
 * than written out, so what is worth testing is the chaining: an edge list in no
 * particular order has to come back as outlines in order, and a wrong one would
 * show up as a smoothing that leaks over an eyelid rather than as an error.
 */

import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { describe, expect, it } from 'vitest';
import {
  CONTOURS,
  type Connection,
  MESH_TRIANGLES,
  pathsFromConnections,
  type Triangle,
  trianglesFromConnections,
} from '../src/core/face/contours';
import { meshConnections, meshTriangles } from './helpers/face';

/** The edges of a closed ring, shuffled and with some of them reversed. */
function scramble(indices: readonly number[]): Connection[] {
  const edges: Connection[] = indices.map((start, i) => ({
    start,
    end: indices[(i + 1) % indices.length] as number,
  }));
  const shuffled = edges.map((edge, i) =>
    i % 3 === 0 ? { start: edge.end, end: edge.start } : edge,
  );
  return [...shuffled.slice(7), ...shuffled.slice(0, 7)];
}

describe('chaining a connection set', () => {
  it('recovers a ring whatever order its edges arrive in', () => {
    const [path, ...rest] = pathsFromConnections(scramble([0, 1, 2, 3, 4, 5]));
    expect(rest).toEqual([]);
    expect(path?.closed).toBe(true);
    expect([...(path?.indices ?? [])].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('returns a ring once, without repeating the vertex it started on', () => {
    const path = pathsFromConnections(scramble([10, 11, 12, 13]))[0];
    expect(path?.indices).toHaveLength(4);
    expect(new Set(path?.indices).size).toBe(4);
  });

  it('keeps consecutive vertices adjacent in the original edge list', () => {
    const ring = [4, 9, 2, 7, 1, 6];
    const edges = new Set(
      ring.map((start, i) => {
        const end = ring[(i + 1) % ring.length] as number;
        return `${Math.min(start, end)}-${Math.max(start, end)}`;
      }),
    );
    const walked = pathsFromConnections(scramble(ring))[0]?.indices ?? [];
    for (let i = 0; i < walked.length; i++) {
      const a = walked[i] as number;
      const b = walked[(i + 1) % walked.length] as number;
      expect(edges.has(`${Math.min(a, b)}-${Math.max(a, b)}`), `${a}-${b}`).toBe(true);
    }
  });

  it('separates two rings that share no vertex', () => {
    const paths = pathsFromConnections([...scramble([0, 1, 2, 3]), ...scramble([8, 9, 10, 11])]);
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.closed)).toBe(true);
    expect(paths.map((path) => path.indices.length)).toEqual([4, 4]);
  });

  it('walks an open line from its end rather than from its middle', () => {
    // A brow arrives as lines along its edges, not as a ring. Starting in the
    // middle of one would return half of it.
    const paths = pathsFromConnections([
      { start: 2, end: 3 },
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
    expect(paths).toHaveLength(1);
    expect(paths[0]?.closed).toBe(false);
    expect(paths[0]?.indices).toHaveLength(4);
    expect([paths[0]?.indices.at(0), paths[0]?.indices.at(-1)].sort()).toEqual([1, 4]);
  });
});

/** How many of a triangle set's triangles each edge belongs to. */
function edgeLoad(triangles: readonly Triangle[]): Map<string, number> {
  const load = new Map<string, number>();
  for (const [a, b, c] of triangles) {
    for (const [p, q] of [
      [a, b],
      [a, c],
      [b, c],
    ] as [number, number][]) {
      const edge = p < q ? `${p},${q}` : `${q},${p}`;
      load.set(edge, (load.get(edge) ?? 0) + 1);
    }
  }
  return load;
}

describe('recovering the mesh from its edges', () => {
  it('returns exactly the faces of a triangulation it is given the edges of', () => {
    // A grid, whose faces are known without computing a triangulation — which is
    // the only way to check this without writing the thing under test twice.
    const expected = meshTriangles()
      .map((triangle) => triangle.join('-'))
      .sort();
    const recovered = trianglesFromConnections(meshConnections())
      .map((triangle) => triangle.join('-'))
      .sort();
    expect(recovered).toEqual(expected);
  });

  it('leaves out the outline three triangles sit inside', () => {
    // Point 3 inside the triangle 0-1-2 and joined to all of its corners, which
    // is the shape the model's tessellation has twice, beside the nose. Four
    // closed walks of three come out of it and only the three around 3 are
    // faces; taking the outline as a fourth draws a flat patch over the detail
    // it covers.
    //
    // What says it is the outline is that each of its edges already has two
    // faces from elsewhere — so the ring of neighbours is part of the case, not
    // scenery. Alone, the same four points are a tetrahedron, and then all four
    // are faces.
    const join = (pairs: [number, number][]): Connection[] =>
      pairs.map(([start, end]) => ({ start, end }));
    const triangles = trianglesFromConnections([
      ...join([
        [0, 1],
        [1, 2],
        [2, 0],
      ]),
      ...join([
        [0, 3],
        [1, 3],
        [2, 3],
      ]),
      ...join([
        [0, 4],
        [1, 4],
        [1, 5],
        [2, 5],
        [0, 6],
        [2, 6],
      ]),
    ]);
    expect(triangles.map((triangle) => triangle.join('-'))).toEqual([
      '0-1-3',
      '0-1-4',
      '0-2-3',
      '0-2-6',
      '1-2-3',
      '1-2-5',
    ]);
  });

  it('finds no surface in an outline', () => {
    // A contour is a ring of edges and encloses no triangles, which is what says
    // the recovery is reading faces rather than anything three points long.
    expect(trianglesFromConnections(scramble([0, 1, 2, 3, 4, 5]))).toEqual([]);
  });
});

describe("the mesh's faces", () => {
  it('accounts for every connection the model publishes', () => {
    // Both directions of an interior edge are published and both of its faces
    // use it; a border edge is published once and used once. So the number of
    // connections is three times the number of faces, whatever those numbers
    // are — which checks the count against the model rather than against a
    // number written down here.
    expect(MESH_TRIANGLES.length * 3).toBe(FaceLandmarker.FACE_LANDMARKS_TESSELATION.length);
  });

  it('describes a surface: every edge carries a face, and none carries three', () => {
    const load = edgeLoad(MESH_TRIANGLES);
    const published = new Set(
      FaceLandmarker.FACE_LANDMARKS_TESSELATION.map(({ start, end }) =>
        start < end ? `${start},${end}` : `${end},${start}`,
      ),
    );
    expect(load.size).toBe(published.size);
    for (const [edge, faces] of load) {
      expect(published.has(edge), edge).toBe(true);
      expect(faces, edge).toBeLessThanOrEqual(2);
    }
  });

  it('is made of mesh points only, and leaves none of them out', () => {
    // The iris points come from the refinement pass and are not tessellated, so
    // a triangle naming one would be a triangle over an eyeball.
    const corners = new Set(MESH_TRIANGLES.flat());
    expect(corners.size).toBe(468);
    expect(Math.max(...corners)).toBe(467);
  });
});

describe('the contours the stages use', () => {
  it('has one outline per part, and two lip rings', () => {
    expect(CONTOURS.faceOval.length).toBeGreaterThan(20);
    expect(CONTOURS.leftEye.length).toBeGreaterThan(8);
    expect(CONTOURS.rightEye.length).toBe(CONTOURS.leftEye.length);
    expect(CONTOURS.lips).toHaveLength(2);
  });

  it('names no landmark twice within one part', () => {
    for (const [part, indices] of Object.entries({
      faceOval: CONTOURS.faceOval,
      leftEye: CONTOURS.leftEye,
      rightEye: CONTOURS.rightEye,
      leftBrow: CONTOURS.leftBrow,
      rightBrow: CONTOURS.rightBrow,
    })) {
      expect(new Set(indices).size, part).toBe(indices.length);
    }
  });

  it('keeps the two sides of the face apart', () => {
    const left = new Set(CONTOURS.leftEye);
    expect(CONTOURS.rightEye.some((i) => left.has(i))).toBe(false);
    const leftBrow = new Set(CONTOURS.leftBrow);
    expect(CONTOURS.rightBrow.some((i) => leftBrow.has(i))).toBe(false);
  });

  it('keeps the lip rings disjoint, so one can be subtracted from the other', () => {
    const [outer, inner] = CONTOURS.lips;
    const set = new Set(outer);
    expect((inner ?? []).some((i) => set.has(i))).toBe(false);
  });

  it('stays inside the landmark count the model returns', () => {
    const every = [
      ...CONTOURS.faceOval,
      ...CONTOURS.leftEye,
      ...CONTOURS.rightEye,
      ...CONTOURS.leftBrow,
      ...CONTOURS.rightBrow,
      ...CONTOURS.lips.flat(),
    ];
    for (const index of every) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(478);
    }
  });
});
