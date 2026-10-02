/**
 * The finish stage's neighbourhood amounts are fractions of the picture, so the
 * preview at any size shows what the file gets at its own.
 */

import { describe, expect, it } from 'vitest';
import type { SourceImage } from '../src/core/io/decode';
import { neutralRecipe, type Recipe } from '../src/core/recipe/schema';
import { Pipeline } from '../src/core/render/pipeline';
import { fakeCanvas, fakeGl } from './gl-fake';

function photo(width: number, height: number): SourceImage {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    space: 'srgb',
  } as unknown as SourceImage;
}

/** Grain cell and sharpen step, each as a fraction of the render's long edge. */
function relative(uniforms: Map<string, unknown[]>): { grain: number; sharpen: [number, number] } {
  const [width, height] = uniforms.get('uResolution') as [number, number];
  const long = Math.max(width, height);
  const [sx, sy] = uniforms.get('uSharpenStep') as [number, number];
  return {
    grain: (uniforms.get('uGrainSize') as [number])[0] / long,
    sharpen: [(sx * width) / long, (sy * height) / long],
  };
}

describe('finish amounts across render sizes', () => {
  it('keeps the grain cell and the sharpen reach the same fraction of the picture', () => {
    const fake = fakeGl();
    const pipeline = new Pipeline(fakeCanvas(fake.gl), () => ({ width: 800, height: 600 }));
    // Portrait, larger than the proxy, so every path below lands on a different size.
    pipeline.setSource(photo(1500, 2000));
    const base = neutralRecipe();
    const recipe: Recipe = {
      ...base,
      global: { ...base.global, sharpen: 0.5, grain: { amount: 0.5, size: 1.5 } },
    };

    const readings: ReturnType<typeof relative>[] = [];
    const sizes: number[] = [];
    const take = () => {
      readings.push(relative(fake.uniforms));
      sizes.push(Math.max(...(fake.uniforms.get('uResolution') as number[])));
    };
    pipeline.renderToCanvas(recipe, 'proxy');
    take();
    pipeline.renderToCanvas(recipe, 'full');
    take();
    pipeline.renderToCanvas(recipe, 'full', { zoom: 3 });
    take();
    const stub = globalThis as { ImageData?: unknown };
    const saved = stub.ImageData;
    stub.ImageData = class {};
    try {
      pipeline.renderThumbnail(recipe, 200);
      take();
      pipeline.readFullResolution(recipe);
      take();
    } finally {
      stub.ImageData = saved;
    }

    expect(new Set(sizes).size).toBeGreaterThanOrEqual(4);
    const [first] = readings as [ReturnType<typeof relative>];
    for (const reading of readings) {
      expect(reading.grain).toBeCloseTo(first.grain, 9);
      expect(reading.sharpen[0]).toBeCloseTo(first.sharpen[0], 9);
      expect(reading.sharpen[1]).toBeCloseTo(first.sharpen[1], 9);
    }
  });
});

describe('the highlight reading', () => {
  it('counts a full-scale source pixel as clipped, rolloff and dither aside', () => {
    const fake = fakeGl();
    const pipeline = new Pipeline(fakeCanvas(fake.gl), () => ({ width: 800, height: 600 }));
    pipeline.setSource(photo(400, 300));
    // What the rolloff writes scene white as, well short of the top code.
    const WHITE = 247;
    let ditherAtRead: unknown[] | undefined;
    fake.onRead = (width, height, out) => {
      if (width === 256 && height === 1) {
        for (let i = 0; i < 256; i++) out.fill(Math.round((i / 255) * WHITE), i * 4, i * 4 + 3);
        return;
      }
      ditherAtRead ??= fake.uniforms.get('uDither');
      // Half the frame is blown out, half is a code below white.
      for (let i = 0; i < width * height; i++) {
        out.fill(i % 2 === 0 ? WHITE : WHITE - 3, i * 4, i * 4 + 3);
        out[i * 4 + 3] = 255;
      }
    };
    const stats = pipeline.measure(neutralRecipe());
    expect(stats.highlightClip).toBeCloseTo(0.5, 6);
    expect(ditherAtRead).toEqual([0]);
  });
});
