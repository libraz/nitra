import { describe, expect, it } from 'vitest';
import { requestWideGamut } from '../src/core/render/gl';

/** A context whose prototype either carries the colour-space property or does not. */
function contextWith(supported: boolean, granted: boolean): WebGL2RenderingContext {
  class Context {}
  if (supported) {
    let space = 'srgb';
    Object.defineProperty(Context.prototype, 'drawingBufferColorSpace', {
      get: () => space,
      set: (value: string) => {
        if (granted) space = value;
      },
    });
  }
  return new Context() as unknown as WebGL2RenderingContext;
}

describe('requestWideGamut', () => {
  it('reports false where the browser has no such property, even though the write reads back', () => {
    const gl = contextWith(false, false);
    expect(requestWideGamut(gl)).toBe(false);
  });

  it('reports what the browser actually granted', () => {
    expect(requestWideGamut(contextWith(true, true))).toBe(true);
    expect(requestWideGamut(contextWith(true, false))).toBe(false);
  });
});
