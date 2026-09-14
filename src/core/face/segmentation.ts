/**
 * How much of the segmentation to believe.
 *
 * The skin mask is the landmark outline intersected with the segmentation's own
 * idea of face skin, and the intersection is what makes it good: the outline is
 * a polygon over a head that has hair in front of it, and the segmentation is a
 * 256-pixel guess that has no idea where an eyebrow is.
 *
 * But the two can disagree, and when they do it is almost always the
 * segmentation that is wrong — it is one network with one opinion about what a
 * person looks like, while the outline has 478 points that agreed with each
 * other. Taking the intersection anyway produces an empty mask, and an empty
 * mask is the worst outcome available: every skin control moves and nothing
 * happens, which reads as a broken app rather than as a hard photograph.
 *
 * So the agreement is measured, and the intersection is weighted by it. Where
 * the segmentation has nothing to say, the outline is used on its own: a mask
 * that is rougher at the hairline, which is worth far more than no mask.
 */

import { type Point, polygonArea } from './geometry';

export interface Segmentation {
  width: number;
  height: number;
  /** Two channels per texel: face-skin confidence, then hair confidence. */
  data: Uint8ClampedArray;
}

/** Below this the segmentation is ignored; above the second, fully believed. */
const DOUBTED = 0.15;
const BELIEVED = 0.45;

/** Points sampled across a face, per axis. */
const SAMPLES = 24;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function inside(polygon: readonly Point[], point: Point): boolean {
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

/**
 * Mean face-skin confidence inside the outlines, in 0..1.
 *
 * Sampled on a grid over each outline rather than over the whole frame: the
 * question is whether the segmentation found skin *where the face is*, and
 * averaging over the background would answer a different one — a face filling a
 * tenth of the frame would look like a disagreement however well it was found.
 *
 * @param faces Outlines in image-width units, as the regions carry them.
 * @param aspect Image height over its width.
 */
export function skinConfidence(
  segmentation: Segmentation,
  faces: readonly { oval: Point[] }[],
  aspect: number,
): number {
  if (faces.length === 0) return 0;
  let total = 0;
  let counted = 0;

  for (const face of faces) {
    if (polygonArea(face.oval) <= 0) continue;
    const xs = face.oval.map((p) => p.x);
    const ys = face.oval.map((p) => p.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);

    for (let j = 0; j < SAMPLES; j++) {
      for (let i = 0; i < SAMPLES; i++) {
        const point = {
          x: x0 + ((i + 0.5) / SAMPLES) * (x1 - x0),
          y: y0 + ((j + 0.5) / SAMPLES) * (y1 - y0),
        };
        if (!inside(face.oval, point)) continue;
        // Back out of width units into the segmentation's own grid.
        const sx = Math.min(segmentation.width - 1, Math.floor(point.x * segmentation.width));
        const sy = Math.min(
          segmentation.height - 1,
          Math.floor((point.y / aspect) * segmentation.height),
        );
        if (sx < 0 || sy < 0) continue;
        total += (segmentation.data[(sy * segmentation.width + sx) * 2] as number) / 255;
        counted += 1;
      }
    }
  }

  return counted === 0 ? 0 : total / counted;
}

/**
 * How much weight the intersection with the segmentation should carry.
 *
 * Ramped rather than switched, so a photo sitting near the threshold does not
 * flip between two different masks on a re-analysis.
 */
export function segmentationWeight(confidence: number): number {
  return smoothstep(DOUBTED, BELIEVED, confidence);
}
