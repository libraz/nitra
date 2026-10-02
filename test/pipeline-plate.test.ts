/**
 * The renderer's bookkeeping around the source and the plate, run against a
 * context with no GPU behind it.
 */

import { describe, expect, it } from 'vitest';
import type { FaceAnalysis } from '../src/core/face/analyze';
import { faceRegions } from '../src/core/face/geometry';
import type { SourceImage } from '../src/core/io/decode';
import { neutralRecipe, type Recipe } from '../src/core/recipe/schema';
import { Pipeline } from '../src/core/render/pipeline';
import { fakeCanvas, fakeGl } from './gl-fake';
import { makeFace } from './helpers/face';

function photo(width: number, height: number): SourceImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 251;
  return {
    width,
    height,
    data,
    space: 'srgb',
    orientation: 1,
    exif: {},
    fileName: 'photo.jpg',
    byteSize: data.length,
  } as unknown as SourceImage;
}

function withSpot(): Recipe {
  const recipe = neutralRecipe();
  return { ...recipe, heal: [{ x: 0.5, y: 0.5, r: 0.03 }] } as Recipe;
}

function setup() {
  const fake = fakeGl();
  const pipeline = new Pipeline(fakeCanvas(fake.gl), () => ({ width: 800, height: 600 }));
  return { fake, pipeline };
}

describe('a replaced photograph', () => {
  it('leaves none of the old photograph’s intermediate buffers allocated', () => {
    const { fake, pipeline } = setup();
    pipeline.setSource(photo(64, 48));
    const recipe = neutralRecipe();
    pipeline.renderToCanvas(recipe, 'proxy');
    pipeline.renderToCanvas(recipe, 'full');
    const baseline = fake.textures.size;
    expect(baseline).toBeGreaterThan(1);

    pipeline.setSource(photo(40, 64));
    // Only the new source texture is left; every target is gone.
    expect(fake.textures.size).toBe(1);
    expect(fake.framebuffers.size).toBe(0);
  });

  it('keeps the buffers a settle cycle used, and frees the ones it did not', () => {
    const { fake, pipeline } = setup();
    pipeline.setSource(photo(64, 48));
    const recipe = neutralRecipe();
    const crop = (w: number): Recipe => ({
      ...recipe,
      geometry: { ...recipe.geometry, crop: { x: 0, y: 0, w, h: 1 } },
    });
    for (const w of [1, 0.9, 0.8, 0.7, 0.6]) {
      pipeline.renderToCanvas(crop(w), 'proxy');
      pipeline.renderToCanvas(crop(w), 'full');
      pipeline.releaseIdle();
    }
    const settled = fake.textures.size;
    for (const w of [0.55, 0.5, 0.45, 0.4]) {
      pipeline.renderToCanvas(crop(w), 'proxy');
      pipeline.renderToCanvas(crop(w), 'full');
      pipeline.releaseIdle();
    }
    expect(fake.textures.size).toBe(settled);
  });
});

describe('an export', () => {
  it('frees its full-size readback target once the pixels are read', () => {
    const { fake, pipeline } = setup();
    pipeline.setSource(photo(64, 48));
    const recipe = neutralRecipe();
    pipeline.renderToCanvas(recipe, 'full');
    const before = fake.textures.size;
    const stub = globalThis as { ImageData?: unknown };
    const saved = stub.ImageData;
    stub.ImageData = class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
      ) {}
    };
    try {
      pipeline.readFullResolution(recipe);
    } finally {
      stub.ImageData = saved;
    }
    expect(fake.textures.size).toBe(before);
  });
});

describe('a plate upload that fails', () => {
  it('is retried by the next sync rather than leaving the fills out', async () => {
    const { fake, pipeline } = setup();
    pipeline.setSource(photo(64, 64));
    const recipe = withSpot();
    fake.fail.set('createTexture', () => null);
    await expect(pipeline.syncPlate(recipe)).rejects.toThrow();

    const before = fake.textures.size;
    await pipeline.syncPlate(recipe);
    // The healed texture was made this time, beside the source.
    expect(fake.textures.size).toBe(before + 1);
  });
});

describe('a restore', () => {
  function analysisOf(size: number): FaceAnalysis {
    const bitmap = (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4).fill(200),
    });
    const face = faceRegions(makeFace({ centre: { x: 0.5, y: 0.5 }, width: 0.4 }), 1);
    return {
      revision: 1,
      faces: [face],
      masks: [bitmap(16, 16), bitmap(16, 16)],
      normals: bitmap(16, 16),
      region: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
      segmentation: bitmap(8, 8),
      segmentationWeight: 1,
      faceWidth: 0.4,
      sourceWidth: size,
      sourceHeight: size,
    } as unknown as FaceAnalysis;
  }

  it('measures the skin again once the restored face is what the filter reads', async () => {
    const { fake, pipeline } = setup();
    const size = 64;
    const source = photo(size, size);
    pipeline.setSource(source);
    const analysis = analysisOf(size);
    pipeline.setFaceAnalysis(analysis);
    pipeline.setReference({
      image: { data: source.data, width: size, height: size, space: 'srgb' },
      faces: analysis.faces,
      fileName: 'reference.jpg',
    });
    const base = neutralRecipe();
    const recipe: Recipe = { ...base, restore: { ...base.restore, reference: 'reference.jpg' } };

    fake.calls.length = 0;
    await pipeline.syncPlate(recipe);
    const upload = fake.calls.lastIndexOf('texSubImage2D');
    const reading = fake.calls.lastIndexOf('readPixels');
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(reading).toBeGreaterThan(upload);

    // Nothing changed, so nothing is read back on the next settle.
    fake.calls.length = 0;
    await pipeline.syncPlate(recipe);
    expect(fake.calls).not.toContain('readPixels');
  });
});
