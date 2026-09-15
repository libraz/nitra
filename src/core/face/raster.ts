/**
 * Face regions to coverage bitmaps.
 *
 * The regions are polygons and discs; the shaders want something they can
 * sample. Turning them into bitmaps on the way in keeps the shaders free of
 * point-in-polygon work, and keeps the awkward part — antialiasing an outline —
 * in code a test can look at.
 *
 * Two bitmaps carry eight channels between them, which is what the stages need.
 * They are built in the source image's own frame, so a crop or a rotation does
 * not invalidate them: the stages sample them through the same matrix that
 * frames the photo.
 *
 * Coverage is written with a maximum rather than accumulated, so two faces
 * overlapping in the frame do not produce a region twice as strong as one.
 */

import type { Disc, FaceRegions, Point } from './geometry';

/** Eight bits per channel, RGBA, the layout {@link FACE_MASK_CHANNELS} names. */
export interface MaskBitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * The part of the photo the masks cover, in normalised image coordinates.
 *
 * Carried alongside them because it is the only way to read them: a stage
 * samples the mask by mapping its own coordinate into the source and then into
 * this rectangle, and anything outside it has no mask at all rather than the
 * nearest edge of one.
 */
export interface FaceMaskRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What lives in which channel.
 *
 * Written down because the shaders read these by swizzle and a silent
 * disagreement would put lip colour on the teeth.
 */
export const FACE_MASK_CHANNELS = {
  skin: { map: 0, channel: 0 },
  features: { map: 0, channel: 1 },
  lips: { map: 0, channel: 2 },
  mouth: { map: 0, channel: 3 },
  sclera: { map: 1, channel: 0 },
  undereye: { map: 1, channel: 1 },
  cheeks: { map: 1, channel: 2 },
  irises: { map: 1, channel: 3 },
} as const;

/** Longest edge of the coverage bitmaps. */
const MASK_LONG_EDGE = 1024;

/** Sub-scanlines per pixel row. Four is where the stair-stepping stops showing. */
const SUBSAMPLES = 4;

/** How far past the faces the working area reaches, as a fraction of a face. */
const REGION_MARGIN = 0.35;

/**
 * The part of the photo the masks are built over.
 *
 * Not the whole frame, and this is the single most consequential number in the
 * face code. A face six per cent of the width of a 4240-pixel photograph is
 * 250 pixels of face; spread the mask over the frame at any affordable size and
 * that face gets fifty of them, and a fifty-pixel mask magnified back up is
 * visible on the result as blotches. Confined to the faces, the same budget
 * resolves them at full size.
 *
 * The margin is a fraction of a face rather than of the image, so it is the
 * same margin on the next photograph. It has to be there: the feather, the
 * under-eye bands and the cheeks all reach outside the outline, and a working
 * area cut to the outline would clip them.
 *
 * Returned in normalised image coordinates, which is what a sampler wants.
 */
export function faceRegion(
  faces: readonly FaceRegions[],
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  if (faces.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  let widest = 0;
  for (const face of faces) {
    for (const point of face.oval) {
      x0 = Math.min(x0, point.x);
      y0 = Math.min(y0, point.y);
      x1 = Math.max(x1, point.x);
      y1 = Math.max(y1, point.y);
    }
    widest = Math.max(widest, face.width);
  }
  const margin = widest * REGION_MARGIN;
  // Back out of width units into the normalised box, where y is divided by the
  // aspect rather than sharing the x scale.
  const left = Math.max(0, x0 - margin);
  const top = Math.max(0, (y0 - margin) / aspect);
  const right = Math.min(1, x1 + margin);
  const bottom = Math.min(1, (y1 + margin) / aspect);
  return {
    x: left,
    y: top,
    width: Math.max(1e-4, right - left),
    height: Math.max(1e-4, bottom - top),
  };
}

/** The size the masks are rasterised at, for a working area of that many pixels. */
export function maskSize(regionWidth: number, regionHeight: number): [number, number] {
  const scale = Math.min(1, MASK_LONG_EDGE / Math.max(regionWidth, regionHeight));
  return [
    Math.max(1, Math.round(regionWidth * scale)),
    Math.max(1, Math.round(regionHeight * scale)),
  ];
}

function blank(width: number, height: number): MaskBitmap {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function raise(bitmap: MaskBitmap, x: number, y: number, channel: number, coverage: number): void {
  if (coverage <= 0) return;
  const index = (y * bitmap.width + x) * 4 + channel;
  const value = Math.round(Math.min(1, coverage) * 255);
  if (value > (bitmap.data[index] as number)) bitmap.data[index] = value;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(edge1 - edge0, 1e-9)));
  return t * t * (3 - 2 * t);
}

/**
 * Fill a polygon, antialiased.
 *
 * Coverage per pixel is the horizontal overlap of the filled spans with the
 * pixel, averaged over several scanlines through it. That is exact in x and
 * sampled in y, which is the right way round: a near-horizontal edge is the one
 * a coarse vertical sampling would turn into stairs, and there are four of them
 * per row.
 *
 * @param points Vertices in image-width units.
 * @param scale Pixels per unit, which is the bitmap's width.
 */
export function fillPolygon(
  bitmap: MaskBitmap,
  channel: number,
  points: readonly Point[],
  scale: number,
): void {
  if (points.length < 3) return;

  const xs = points.map((p) => p.x * scale);
  const ys = points.map((p) => p.y * scale);
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const bottom = Math.min(bitmap.height - 1, Math.ceil(Math.max(...ys)));
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const right = Math.min(bitmap.width - 1, Math.ceil(Math.max(...xs)));
  if (bottom < top || right < left) return;

  const row = new Float32Array(right - left + 2);
  const crossings: number[] = [];

  for (let y = top; y <= bottom; y++) {
    row.fill(0);
    let any = false;

    for (let s = 0; s < SUBSAMPLES; s++) {
      const sampleY = y + (s + 0.5) / SUBSAMPLES;
      crossings.length = 0;
      for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        const y0 = ys[i] as number;
        const y1 = ys[j] as number;
        if (y0 === y1) continue;
        // Half-open in y, so a vertex shared by two edges is counted once.
        if (sampleY < Math.min(y0, y1) || sampleY >= Math.max(y0, y1)) continue;
        const x0 = xs[i] as number;
        const x1 = xs[j] as number;
        crossings.push(x0 + ((sampleY - y0) / (y1 - y0)) * (x1 - x0));
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);

      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const spanStart = Math.max(crossings[k] as number, left);
        const spanEnd = Math.min(crossings[k + 1] as number, right + 1);
        if (spanEnd <= spanStart) continue;
        any = true;
        const first = Math.floor(spanStart);
        const last = Math.min(right, Math.ceil(spanEnd) - 1);
        for (let x = first; x <= last; x++) {
          const overlap = Math.min(spanEnd, x + 1) - Math.max(spanStart, x);
          if (overlap > 0) row[x - left] = (row[x - left] as number) + overlap / SUBSAMPLES;
        }
      }
    }

    if (!any) continue;
    for (let x = left; x <= right; x++) raise(bitmap, x, y, channel, row[x - left] as number);
  }
}

/** Fill a disc whose edge fades out, for the regions that have no outline. */
export function fillDisc(bitmap: MaskBitmap, channel: number, disc: Disc, scale: number): void {
  const cx = disc.centre.x * scale;
  const cy = disc.centre.y * scale;
  const inner = disc.radius * scale;
  const outer = (disc.radius + disc.feather) * scale;
  const top = Math.max(0, Math.floor(cy - outer));
  const bottom = Math.min(bitmap.height - 1, Math.ceil(cy + outer));
  const left = Math.max(0, Math.floor(cx - outer));
  const right = Math.min(bitmap.width - 1, Math.ceil(cx + outer));

  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      raise(bitmap, x, y, channel, 1 - smoothstep(inner, outer, d));
    }
  }
}

/**
 * Rasterise every face in the frame into the two coverage bitmaps.
 *
 * The skin channel is the face outline with the features taken out of it later,
 * on the GPU, where the segmentation is available to intersect with — doing the
 * subtraction here would throw away the soft edge before the segmentation has
 * had a chance to refine it.
 */
export function rasteriseFaces(
  faces: readonly FaceRegions[],
  sourceWidth: number,
  sourceHeight: number,
  aspect: number,
): { maps: [MaskBitmap, MaskBitmap]; region: FaceMaskRegion } {
  const box = faceRegion(faces, aspect);
  const [width, height] = maskSize(box.width * sourceWidth, box.height * sourceHeight);
  const maps: [MaskBitmap, MaskBitmap] = [blank(width, height), blank(width, height)];

  // Pixels per unit of image width, and the offset of the working area, both in
  // the isotropic units the regions are measured in.
  const scale = width / box.width;
  const shift = { x: box.x, y: box.y * aspect };
  const place = (points: readonly Point[]) =>
    points.map((p) => ({ x: p.x - shift.x, y: p.y - shift.y }));

  for (const face of faces) {
    const c = FACE_MASK_CHANNELS;
    fillPolygon(maps[c.skin.map], c.skin.channel, place(face.oval), scale);
    for (const feature of face.features) {
      fillPolygon(maps[c.features.map], c.features.channel, place(feature), scale);
    }
    fillPolygon(maps[c.lips.map], c.lips.channel, place(face.lips), scale);
    fillPolygon(maps[c.mouth.map], c.mouth.channel, place(face.mouth), scale);
    for (const eye of face.sclera) {
      fillPolygon(maps[c.sclera.map], c.sclera.channel, place(eye), scale);
    }
    for (const band of face.undereye) {
      fillPolygon(maps[c.undereye.map], c.undereye.channel, place(band), scale);
    }
    for (const cheek of face.cheeks) {
      fillDisc(
        maps[c.cheeks.map],
        c.cheeks.channel,
        { ...cheek, centre: { x: cheek.centre.x - shift.x, y: cheek.centre.y - shift.y } },
        scale,
      );
    }
    for (const iris of face.irises) {
      fillDisc(
        maps[c.irises.map],
        c.irises.channel,
        { ...iris, centre: { x: iris.centre.x - shift.x, y: iris.centre.y - shift.y } },
        scale,
      );
    }
  }

  return { maps, region: box };
}
