import { describe, expect, it } from 'vitest';
import { shrinkToFit } from '../src/core/io/shrink';

function solid(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { data, width, height };
}

describe('shrinkToFit', () => {
  it('returns the same image when it already fits', () => {
    const image = solid(40, 20, [10, 20, 30, 255]);
    expect(shrinkToFit(image, 40)).toBe(image);
  });

  it('brings the long edge to the limit and keeps the shape', () => {
    expect(shrinkToFit(solid(200, 50, [0, 0, 0, 255]), 64)).toMatchObject({
      width: 64,
      height: 16,
    });
    expect(shrinkToFit(solid(30, 301, [0, 0, 0, 255]), 100)).toMatchObject({
      width: 10,
      height: 100,
    });
  });

  it('leaves a flat colour unchanged at a fractional ratio', () => {
    const out = shrinkToFit(solid(97, 61, [37, 128, 222, 255]), 41);
    for (let i = 0; i < out.data.length; i += 4) {
      expect([...out.data.subarray(i, i + 4)]).toEqual([37, 128, 222, 255]);
    }
  });

  it('averages light, not code values', () => {
    // Alternating black and white columns halved: the mean of the light is
    // 0.5 linear, which encodes to 188; averaging codes would give 128.
    const image = solid(64, 4, [0, 0, 0, 255]);
    for (let y = 0; y < 4; y++) {
      for (let x = 1; x < 64; x += 2) image.data.set([255, 255, 255, 255], (y * 64 + x) * 4);
    }
    const out = shrinkToFit(image, 32);
    for (let i = 0; i < out.data.length; i += 4) expect(out.data[i]).toBe(188);
  });

  it('weights colour by coverage so a transparent pixel adds no colour', () => {
    const image = solid(2, 1, [255, 0, 0, 255]);
    image.data.set([0, 0, 255, 0], 4);
    const out = shrinkToFit(image, 1);
    expect([...out.data]).toEqual([255, 0, 0, 128]);
  });
});
