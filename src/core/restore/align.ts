/**
 * Putting a photograph's own face back where a generator replaced it.
 *
 * A generative edit — a new background, a different costume, a caption burnt in
 * — is an edit of the whole frame, and the face comes back as somebody else's.
 * What is wanted is the face that was photographed, in the place the generator
 * left for it. That is a registration problem rather than a compositing one:
 * both images are the same photograph, so nothing has to be placed by hand.
 *
 * The correspondence is free. The mesh is the same 468 points in the same order
 * on both, so point i of one is point i of the other, and the transform between
 * them is a least-squares fit rather than a search.
 *
 * It is fitted as a similarity — a turn, a scale and a shift — and deliberately
 * as nothing more general. An affine fit would shear the photographed face onto
 * the generated one's proportions, and a mesh warp would put the generated
 * face's shape on the photographed face's skin, which is the thing this exists
 * to undo. Whatever the fit cannot absorb is measured instead, and reported.
 */

import type { FaceRegions, Point } from '../face/geometry';

/**
 * How far apart two faces may sit and still be the same face, as a fraction of
 * the destination face's width.
 *
 * Generous, because the images are registered: a generator that moved a face by
 * most of its own width has done something this stage cannot repair anyway, and
 * the residual below is what says so. What this bound is actually for is a group
 * photograph, where the nearest face has to be the right one.
 */
const PAIR_REACH = 0.6;

/**
 * A turn, a scale and a shift, as four numbers.
 *
 * Not a 3x3 matrix, for the reason the light's direction is two angles rather
 * than a vector: a similarity has four degrees of freedom, and writing it as
 * nine numbers would let something construct one that is not a similarity at
 * all. The rotation never appears as an angle either — the fit produces `c` and
 * `s` directly, so no inverse trigonometry is involved anywhere in the chain.
 */
export interface Similarity {
  /** Scale times the cosine of the turn. */
  c: number;
  /** Scale times its sine. */
  s: number;
  tx: number;
  ty: number;
}

/** A face in one image and the same face in the other. */
export interface FacePair {
  /** Index into the destination image's faces. */
  destination: number;
  /** Index into the reference image's faces. */
  reference: number;
  /** Takes a reference point, in its image's width units, to the destination's. */
  transform: Similarity;
  /**
   * What the fit could not explain, as a fraction of the destination face width.
   *
   * The whole guardrail. A similarity accounts for the face being moved, turned
   * and resized; it cannot account for the face having been given a different
   * shape, a different pose or a different expression, and that is exactly the
   * case where a patch cannot be laid over the frame the generator left. Rather
   * than refusing, this is measured and shown — the design's own rule is to
   * measure overreach and present it rather than to prevent it.
   */
  residual: number;
  /** How much larger the face is in the destination than in the reference. */
  scale: number;
}

export function applySimilarity(m: Similarity, p: { x: number; y: number }): Point {
  return { x: m.c * p.x - m.s * p.y + m.tx, y: m.s * p.x + m.c * p.y + m.ty };
}

/** The transform that undoes `m`, or null when it collapses the plane. */
export function invertSimilarity(m: Similarity): Similarity | null {
  const square = m.c * m.c + m.s * m.s;
  if (square < 1e-12) return null;
  const c = m.c / square;
  const s = -m.s / square;
  return { c, s, tx: -(c * m.tx - s * m.ty), ty: -(s * m.tx + c * m.ty) };
}

/** How much larger the transform makes things. */
export function similarityScale(m: Similarity): number {
  return Math.sqrt(m.c * m.c + m.s * m.s);
}

/**
 * The similarity that best takes `from` onto `to`, in the least-squares sense.
 *
 * Closed form, and arithmetic all the way through: centre both sets, then the
 * rotation-and-scale pair falls out as the dot and cross products of the
 * centred points over the first set's squared length. No angle is ever taken,
 * which matters for the same reason it matters in the fill — a recipe naming a
 * restore has to produce the same pixels in every browser, and the precision of
 * an inverse trigonometric function is left to the engine.
 *
 * @param from Points in the source image's own width units.
 * @param to The matching points, in the destination's.
 */
export function fitSimilarity(
  from: readonly { x: number; y: number }[],
  to: readonly { x: number; y: number }[],
): Similarity | null {
  const n = Math.min(from.length, to.length);
  if (n < 2) return null;

  let fx = 0;
  let fy = 0;
  let tx = 0;
  let ty = 0;
  for (let i = 0; i < n; i++) {
    fx += (from[i] as Point).x;
    fy += (from[i] as Point).y;
    tx += (to[i] as Point).x;
    ty += (to[i] as Point).y;
  }
  fx /= n;
  fy /= n;
  tx /= n;
  ty /= n;

  let dot = 0;
  let cross = 0;
  let square = 0;
  for (let i = 0; i < n; i++) {
    const px = (from[i] as Point).x - fx;
    const py = (from[i] as Point).y - fy;
    const qx = (to[i] as Point).x - tx;
    const qy = (to[i] as Point).y - ty;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    square += px * px + py * py;
  }
  // Every point in one place. There is no scale to recover and no turn either,
  // and returning a shift is better than returning a transform full of
  // infinities that renders as a blank patch.
  if (square < 1e-12) return { c: 1, s: 0, tx: tx - fx, ty: ty - fy };

  const c = dot / square;
  const s = cross / square;
  return { c, s, tx: tx - (c * fx - s * fy), ty: ty - (s * fx + c * fy) };
}

/** Root-mean-square of what the fit left over, in the destination's units. */
export function fitResidual(
  from: readonly { x: number; y: number }[],
  to: readonly { x: number; y: number }[],
  m: Similarity,
): number {
  const n = Math.min(from.length, to.length);
  if (n === 0) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = applySimilarity(m, from[i] as Point);
    const dx = p.x - (to[i] as Point).x;
    const dy = p.y - (to[i] as Point).y;
    total += dx * dx + dy * dy;
  }
  return Math.sqrt(total / n);
}

/**
 * What to add to a reference centre before it is compared with a destination's.
 *
 * Zero unless the two sides hold the same number of faces, in which case it is
 * whatever moved all of them together — a reframing rather than anybody moving.
 */
function commonShift(
  destination: readonly FaceRegions[],
  reference: readonly FaceRegions[],
): Point {
  if (destination.length === 0 || destination.length !== reference.length) return { x: 0, y: 0 };
  // Between the two groups' own centres, which needs no correspondence between
  // them — the pairing is what this is being worked out in order to find.
  const mean = (faces: readonly FaceRegions[]): Point => ({
    x: faces.reduce((total, face) => total + face.centre.x, 0) / faces.length,
    y: faces.reduce((total, face) => total + face.centre.y, 0) / faces.length,
  });
  const here = mean(destination);
  const there = mean(reference);
  return { x: here.x - there.x, y: here.y - there.y };
}

/**
 * Work out which face in the reference is which face in the destination.
 *
 * By nearest centre, which is sound here and would not be in general: the two
 * images are the same photograph, so a face has not gone anywhere much. Each
 * reference face is spent once, so two destination faces cannot both claim it —
 * on a group photograph that would otherwise paste one person's face onto two
 * people.
 *
 * Ordered by how close the pairing is rather than by position in the frame, so
 * the confident pairs are made before the doubtful ones get to consume a face.
 *
 * **The distance is measured after a shift the two sets share is taken out.** A
 * coordinate here is a fraction of the image's own width, so a generator that
 * returns a square crop of a 4:3 frame moves every face down the y axis by an
 * eighth of a width without anything having moved in the photograph. That shift
 * is the same for every face, and the reach has no opinion about it: what the
 * reach is for is telling one person in a group from another, which is a
 * question about where the faces sit relative to each other. Lining the two sets
 * up by their common centre first is what makes the answer about that and
 * nothing else — with one face on each side it removes the distance entirely,
 * which is the case that has nothing to confuse.
 *
 * It is taken out only when the two sides hold the same number of faces. With
 * different counts the two centres are not the centre of the same group, and
 * subtracting one from the other would pull a lone reference face towards the
 * middle of a crowd it is not in the middle of. What actually says whether two
 * faces are the same face is the residual, which is measured either way.
 */
export function pairFaces(
  destination: readonly FaceRegions[],
  reference: readonly FaceRegions[],
): FacePair[] {
  const shift = commonShift(destination, reference);
  const candidates: { destination: number; reference: number; distance: number }[] = [];
  for (let d = 0; d < destination.length; d++) {
    const target = destination[d] as FaceRegions;
    for (let r = 0; r < reference.length; r++) {
      const other = reference[r] as FaceRegions;
      const distance = Math.hypot(
        target.centre.x - (other.centre.x + shift.x),
        target.centre.y - (other.centre.y + shift.y),
      );
      if (distance > target.width * PAIR_REACH) continue;
      candidates.push({ destination: d, reference: r, distance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);

  const takenDestination = new Set<number>();
  const takenReference = new Set<number>();
  const pairs: FacePair[] = [];

  for (const candidate of candidates) {
    if (takenDestination.has(candidate.destination)) continue;
    if (takenReference.has(candidate.reference)) continue;
    const target = destination[candidate.destination] as FaceRegions;
    const other = reference[candidate.reference] as FaceRegions;
    const transform = fitSimilarity(other.surface, target.surface);
    if (!transform) continue;

    takenDestination.add(candidate.destination);
    takenReference.add(candidate.reference);
    pairs.push({
      destination: candidate.destination,
      reference: candidate.reference,
      transform,
      residual:
        fitResidual(other.surface, target.surface, transform) / Math.max(target.width, 1e-6),
      scale: similarityScale(transform),
    });
  }

  return pairs.sort((a, b) => a.destination - b.destination);
}
