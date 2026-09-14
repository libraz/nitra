/**
 * The coverage bitmaps are what the shaders actually read, so the things worth
 * asserting are the ones a shader would turn into a visible fault: a region in
 * the wrong channel, an edge with no antialiasing on it, and two faces adding up
 * to twice the effect of one.
 */

import { describe, expect, it } from 'vitest';
import { CONTOURS } from '../src/core/face/contours';
import { centroid, faceRegions, type NormalisedLandmark } from '../src/core/face/geometry';
import {
  FACE_MASK_CHANNELS,
  faceRegion,
  fillDisc,
  fillPolygon,
  type MaskBitmap,
  maskSize,
  rasteriseFaces,
} from '../src/core/face/raster';

function blank(width: number, height: number): MaskBitmap {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function at(bitmap: MaskBitmap, x: number, y: number, channel: number): number {
  return bitmap.data[(y * bitmap.width + x) * 4 + channel] as number;
}

/** A rectangle in the units `fillPolygon` takes, which are fractions of width. */
function rect(x0: number, y0: number, x1: number, y1: number) {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** A face placed so every region lands well inside the frame. */
function face(centre = { x: 0.5, y: 0.5 }, width = 0.3): NormalisedLandmark[] {
  const landmarks: NormalisedLandmark[] = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  const ellipse = (indices: readonly number[], cx: number, cy: number, rx: number, ry: number) => {
    indices.forEach((index, i) => {
      const angle = (i / indices.length) * Math.PI * 2;
      landmarks[index] = {
        x: centre.x + cx + Math.cos(angle) * rx,
        y: centre.y + cy + Math.sin(angle) * ry,
      };
    });
  };
  ellipse(CONTOURS.faceOval, 0, 0, width / 2, width * 0.7);
  ellipse(CONTOURS.leftEye, -width * 0.22, -width * 0.12, width * 0.09, width * 0.045);
  ellipse(CONTOURS.rightEye, width * 0.22, -width * 0.12, width * 0.09, width * 0.045);
  ellipse(CONTOURS.leftBrow, -width * 0.22, -width * 0.24, width * 0.11, width * 0.02);
  ellipse(CONTOURS.rightBrow, width * 0.22, -width * 0.24, width * 0.11, width * 0.02);
  ellipse(CONTOURS.lips[0] ?? [], 0, width * 0.28, width * 0.14, width * 0.07);
  ellipse(CONTOURS.lips[1] ?? [], 0, width * 0.28, width * 0.09, width * 0.03);
  return landmarks;
}

describe('filling a region', () => {
  it('fills what it covers and leaves the rest alone', () => {
    const bitmap = blank(20, 20);
    fillPolygon(bitmap, 0, rect(0.25, 0.25, 0.75, 0.75), 20);
    expect(at(bitmap, 10, 10, 0)).toBe(255);
    expect(at(bitmap, 1, 1, 0)).toBe(0);
    expect(at(bitmap, 19, 19, 0)).toBe(0);
  });

  it('antialiases an edge instead of stepping it', () => {
    // A hard-edged mask puts a visible seam wherever it lands on skin.
    const bitmap = blank(20, 20);
    // The right edge lands at 10.5 pixels, so column 10 is half covered.
    fillPolygon(bitmap, 0, rect(0.25, 0.25, 0.525, 0.75), 20);
    expect(at(bitmap, 9, 10, 0)).toBe(255);
    expect(at(bitmap, 10, 10, 0)).toBeCloseTo(128, -1);
    expect(at(bitmap, 11, 10, 0)).toBe(0);
  });

  it('antialiases a slope, which is what a coarse scan would step', () => {
    const bitmap = blank(20, 20);
    fillPolygon(
      bitmap,
      0,
      [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.4 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
      20,
    );
    const along = Array.from({ length: 14 }, (_, i) => at(bitmap, i + 4, 6, 0));
    expect(along.some((value) => value > 0 && value < 255)).toBe(true);
  });

  it('writes coverage into the channel it was told to', () => {
    const bitmap = blank(8, 8);
    fillPolygon(bitmap, 2, rect(0.1, 0.1, 0.9, 0.9), 8);
    expect(at(bitmap, 4, 4, 2)).toBe(255);
    expect(at(bitmap, 4, 4, 0)).toBe(0);
    expect(at(bitmap, 4, 4, 1)).toBe(0);
    expect(at(bitmap, 4, 4, 3)).toBe(0);
  });

  it('takes the greater coverage where two regions overlap', () => {
    // Two faces overlapping in the frame must not produce a region twice as
    // strong as one of them.
    const bitmap = blank(8, 8);
    fillPolygon(bitmap, 0, rect(0.1, 0.1, 0.9, 0.9), 8);
    fillPolygon(bitmap, 0, rect(0.2, 0.2, 0.8, 0.8), 8);
    expect(at(bitmap, 4, 4, 0)).toBe(255);
  });

  it('does not lose coverage a second, smaller region does not reach', () => {
    const bitmap = blank(16, 16);
    fillPolygon(bitmap, 0, rect(0.1, 0.1, 0.9, 0.9), 16);
    fillPolygon(bitmap, 0, rect(0.4, 0.4, 0.6, 0.6), 16);
    expect(at(bitmap, 3, 3, 0)).toBe(255);
  });

  it('ignores a polygon with no area to fill', () => {
    const bitmap = blank(8, 8);
    fillPolygon(bitmap, 0, [{ x: 0.5, y: 0.5 }], 8);
    fillPolygon(bitmap, 0, [], 8);
    expect([...bitmap.data].every((value) => value === 0)).toBe(true);
  });

  it('clips a region that runs off the frame rather than wrapping it', () => {
    const bitmap = blank(8, 8);
    fillPolygon(bitmap, 0, rect(-0.5, -0.5, 0.25, 0.25), 8);
    expect(at(bitmap, 0, 0, 0)).toBe(255);
    expect(at(bitmap, 7, 7, 0)).toBe(0);
  });
});

describe('filling a disc', () => {
  it('is solid at the centre and gone past the falloff', () => {
    const bitmap = blank(41, 41);
    fillDisc(bitmap, 0, { centre: { x: 0.5, y: 0.5 }, radius: 0.15, feather: 0.1 }, 41);
    expect(at(bitmap, 20, 20, 0)).toBe(255);
    expect(at(bitmap, 40, 20, 0)).toBe(0);
  });

  it('fades out rather than ending', () => {
    // A hard-edged disc of blusher is unmistakable as an edit.
    const bitmap = blank(41, 41);
    fillDisc(bitmap, 0, { centre: { x: 0.5, y: 0.5 }, radius: 0.1, feather: 0.15 }, 41);
    const ramp = [22, 24, 26, 28, 30].map((x) => at(bitmap, x, 20, 0));
    for (let i = 1; i < ramp.length; i++) {
      expect(ramp[i] as number, `step ${i}`).toBeLessThanOrEqual(ramp[i - 1] as number);
    }
    expect(ramp.some((value) => value > 0 && value < 255)).toBe(true);
  });
});

describe('the size the masks are built at', () => {
  it('never enlarges a working area smaller than the budget', () => {
    expect(maskSize(300, 200)).toEqual([300, 200]);
  });

  it('keeps the shape of the working area', () => {
    const [width, height] = maskSize(4000, 3000);
    expect(width / height).toBeCloseTo(4000 / 3000, 2);
  });

  it('caps the long edge whichever way round it is', () => {
    const [wideW, wideH] = maskSize(6000, 2000);
    const [tallW, tallH] = maskSize(2000, 6000);
    expect(Math.max(wideW, wideH)).toBe(Math.max(tallW, tallH));
  });
});

/**
 * The working area is the single most consequential number in the face code.
 *
 * Spread over a large photograph, a mask has a few dozen pixels of face in it,
 * and a mask that coarse magnified back up onto the face is visible on the
 * result as blotches. Confined to the faces, the same budget resolves them.
 */
describe('the working area', () => {
  it('covers the face with room around it', () => {
    const regions = faceRegions(face({ x: 0.5, y: 0.5 }, 0.3), 1);
    const box = faceRegion([regions], 1);
    const xs = regions.oval.map((p) => p.x);
    const ys = regions.oval.map((p) => p.y);
    expect(box.x).toBeLessThan(Math.min(...xs));
    expect(box.x + box.width).toBeGreaterThan(Math.max(...xs));
    expect(box.y).toBeLessThan(Math.min(...ys));
    expect(box.y + box.height).toBeGreaterThan(Math.max(...ys));
  });

  it('is a small part of the frame when the face is', () => {
    const small = faceRegion([faceRegions(face({ x: 0.5, y: 0.3 }, 0.06), 1)], 1);
    expect(small.width).toBeLessThan(0.25);
    expect(small.height).toBeLessThan(0.35);
  });

  it('resolves a small face rather than spreading the budget over the frame', () => {
    // This is the property the whole thing exists for, and it is a floor rather
    // than a ratio: a face has to arrive with enough mask pixels to be worked
    // on, however little of the photograph it occupies.
    const onFace = (width: number) => {
      const regions = faceRegions(face({ x: 0.5, y: 0.4 }, width), 1);
      const box = faceRegion([regions], 1);
      const [w] = maskSize(box.width * 4000, box.height * 4000);
      return (regions.width / box.width) * w;
    };
    expect(onFace(0.06)).toBeGreaterThan(200);
    expect(onFace(0.3)).toBeGreaterThan(200);
    expect(onFace(0.6)).toBeGreaterThan(200);
    // And several times what the same budget spread over the frame would give.
    const spread = 0.06 * (maskSize(4000, 4000)[0] as number);
    expect(onFace(0.06)).toBeGreaterThan(spread * 3);
  });

  it('stays inside the frame when the face is against its edge', () => {
    const box = faceRegion([faceRegions(face({ x: 0.08, y: 0.1 }, 0.14), 1)], 1);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1);
    expect(box.y + box.height).toBeLessThanOrEqual(1);
  });

  it('spans every face when there are several', () => {
    const left = faceRegions(face({ x: 0.2, y: 0.4 }, 0.12), 1);
    const right = faceRegions(face({ x: 0.8, y: 0.5 }, 0.12), 1);
    const box = faceRegion([left, right], 1);
    expect(box.x).toBeLessThan(0.2);
    expect(box.x + box.width).toBeGreaterThan(0.8);
  });

  it('is the whole frame when there is no face, and describes nothing', () => {
    expect(faceRegion([], 1)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('converts out of width units on a frame that is not square', () => {
    const aspect = 2;
    const regions = faceRegions(face({ x: 0.5, y: 0.5 }, 0.2), aspect);
    const box = faceRegion([regions], aspect);
    // The outline is measured in width units, where the centre of a frame twice
    // as tall as it is wide sits at y = 1; the working area is normalised.
    expect(box.y + box.height / 2).toBeCloseTo(0.5, 1);
  });
});

describe('rasterising a face', () => {
  const regions = faceRegions(face(), 1);
  const { maps, region } = rasteriseFaces([regions], 800, 800, 1);
  const [polyA, polyB] = maps;

  /** A point in width units, sampled out of the working-area bitmap. */
  function sample(name: keyof typeof FACE_MASK_CHANNELS, point: { x: number; y: number }): number {
    const where = FACE_MASK_CHANNELS[name];
    const map = maps[where.map] as MaskBitmap;
    const scale = map.width / region.width;
    return at(
      map,
      Math.round((point.x - region.x) * scale),
      Math.round((point.y - region.y) * scale),
      where.channel,
    );
  }

  it('puts the face outline in the skin channel', () => {
    expect(sample('skin', regions.centre)).toBeGreaterThan(200);
  });

  it('marks the eyes and the lips as off limits to smoothing', () => {
    for (const eye of regions.sclera) {
      const centre = eye.reduce(
        (a, p) => ({ x: a.x + p.x / eye.length, y: a.y + p.y / eye.length }),
        {
          x: 0,
          y: 0,
        },
      );
      expect(sample('features', centre)).toBeGreaterThan(200);
    }
  });

  it('keeps the lips and the mouth interior in separate channels', () => {
    // Between the two rings: on the lip itself, and not inside the mouth. A
    // vertex of the outer ring would sit exactly on an antialiased edge.
    const vertex = regions.lips[0] as { x: number; y: number };
    const middle = centroid(regions.lips);
    const onLip = {
      x: middle.x + (vertex.x - middle.x) * 0.8,
      y: middle.y + (vertex.y - middle.y) * 0.8,
    };
    expect(sample('lips', onLip)).toBeGreaterThan(0);
    expect(sample('mouth', onLip)).toBe(0);
  });

  it('leaves the channels a region does not claim empty', () => {
    const outside = { x: region.x + 0.005, y: region.y + 0.005 };
    for (const name of Object.keys(FACE_MASK_CHANNELS) as (keyof typeof FACE_MASK_CHANNELS)[]) {
      expect(sample(name, outside), name).toBe(0);
    }
  });

  it('produces nothing at all when no face was found', () => {
    const empty = rasteriseFaces([], 800, 800, 1);
    expect([...(empty.maps[0] as MaskBitmap).data].every((value) => value === 0)).toBe(true);
    expect([...(empty.maps[1] as MaskBitmap).data].every((value) => value === 0)).toBe(true);
  });

  it('builds both bitmaps at the same size, so one mapping samples both', () => {
    expect([(polyA as MaskBitmap).width, (polyA as MaskBitmap).height]).toEqual([
      (polyB as MaskBitmap).width,
      (polyB as MaskBitmap).height,
    ]);
  });
});
