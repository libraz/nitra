/**
 * The finish stage's neighbourhood amounts are fractions of the picture, so the
 * preview at any size shows what the file gets at its own.
 */

import { describe, expect, it } from 'vitest';
import type { SourceImage } from '../src/core/io/decode';
import { neutralRecipe, type Recipe } from '../src/core/recipe/schema';
import type { PassContext } from '../src/core/render/context';
import { Pipeline } from '../src/core/render/pipeline';
import { PROXY_LONG_EDGE, sharpenSize } from '../src/core/render/uniforms';
import { fakeCanvas, fakeGl } from './gl-fake';

function photo(width: number, height: number): SourceImage {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    space: 'srgb',
  } as unknown as SourceImage;
}

/** Grain cell, as a fraction of the render's long edge. */
function relative(uniforms: Map<string, unknown[]>): { grain: number } {
  const [width, height] = uniforms.get('uResolution') as [number, number];
  return { grain: (uniforms.get('uGrainSize') as [number])[0] / Math.max(width, height) };
}

describe('finish amounts across render sizes', () => {
  it('keeps the grain cell the same fraction of the picture', () => {
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
    }
  });

  it('sharpens against a copy the size of the proxy, whatever the render', () => {
    // The reach is a pixel of the proxy. Read off a copy that size, a larger
    // render is sharpened in the band the preview showed: four taps that far
    // apart on the export itself were a comb that doubled detail the preview
    // never had.
    for (const [width, height] of [
      [4000, 3000],
      [1500, 2000],
      [1024, 683],
      [200, 150],
    ] as const) {
      const [w, h] = sharpenSize({ width, height } as PassContext);
      expect(Math.max(w, h)).toBe(PROXY_LONG_EDGE);
      expect(w / h).toBeCloseTo(width / height, 2);
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
