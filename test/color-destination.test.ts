/**
 * Every exit from the finish stage writes the primaries its destination
 * carries: the screen the drawing buffer's, a file or a reading the output
 * space it is tagged with.
 */

import { describe, expect, it } from 'vitest';
import type { ColorSpaceName } from '../src/core/color/spaces';
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

/** A pipeline whose drawing buffer either takes Display-P3 or stays sRGB. */
function pipelineWith(wideGamut: boolean) {
  const fake = fakeGl();
  // A context without wide-gamut support keeps its buffer sRGB whatever is assigned.
  const gl = wideGamut
    ? fake.gl
    : (new Proxy(fake.gl, {
        set(target, prop, value) {
          if (prop === 'drawingBufferColorSpace') return true;
          return Reflect.set(target, prop, value);
        },
      }) as WebGL2RenderingContext);
  const pipeline = new Pipeline(fakeCanvas(gl), () => ({ width: 800, height: 600 }));
  pipeline.setSource(photo(400, 300));
  return { fake, pipeline };
}

function withSpace(space: ColorSpaceName): Recipe {
  const base = neutralRecipe();
  return { ...base, output: { ...base.output, space } };
}

/** Run `fn` with an ImageData stand-in that records the tag it was given. */
function tagOf(fn: () => unknown): string | undefined {
  const stub = globalThis as { ImageData?: unknown };
  const saved = stub.ImageData;
  stub.ImageData = class {
    colorSpace: string | undefined;
    constructor(_data: unknown, _w: number, _h: number, settings?: { colorSpace?: string }) {
      this.colorSpace = settings?.colorSpace;
    }
  };
  try {
    return (fn() as { colorSpace?: string }).colorSpace;
  } finally {
    stub.ImageData = saved;
  }
}

const SPACES: ColorSpaceName[] = ['srgb', 'display-p3'];

describe('destination primaries', () => {
  for (const wideGamut of [true, false]) {
    for (const space of SPACES) {
      const toSrgb = [space === 'srgb' ? 1 : 0];

      it(`writes the file in its own tag (${space}, ${wideGamut ? 'P3' : 'sRGB'} buffer)`, () => {
        const { fake, pipeline } = pipelineWith(wideGamut);
        expect(pipeline.wideGamut).toBe(wideGamut);
        const recipe = withSpace(space);

        expect(tagOf(() => pipeline.readFullResolution(recipe))).toBe(space);
        expect(fake.uniforms.get('uToSrgb')).toEqual(toSrgb);

        expect(tagOf(() => pipeline.renderThumbnail(recipe, 64))).toBe(space);
        expect(fake.uniforms.get('uToSrgb')).toEqual(toSrgb);

        pipeline.toneResponse(recipe);
        expect(fake.uniforms.get('uToSrgb')).toEqual(toSrgb);
      });

      it(`writes the screen in the buffer's primaries (${space}, ${wideGamut ? 'P3' : 'sRGB'} buffer)`, () => {
        const { fake, pipeline } = pipelineWith(wideGamut);
        const recipe = withSpace(space);
        pipeline.renderToCanvas(recipe, 'proxy');
        expect(fake.uniforms.get('uToSrgb')).toEqual([wideGamut ? 0 : 1]);
        pipeline.renderToCanvas(recipe, 'proxy', { original: true });
        expect(fake.uniforms.get('uToSrgb')).toEqual([wideGamut ? 0 : 1]);
      });
    }
  }
});
