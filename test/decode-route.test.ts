import { describe, expect, it } from 'vitest';
import { routeDecoder } from '../src/core/io/decode';

function ftyp(brand: string): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70]);
  for (let i = 0; i < 4; i++) b[8 + i] = brand.charCodeAt(i);
  return b;
}

describe('decoder routing', () => {
  it('sends AV1 brands to the browser decoder first, never straight to libheif', () => {
    expect(routeDecoder(ftyp('avif'))).toBe('avif');
    expect(routeDecoder(ftyp('avis'))).toBe('avif');
  });

  it('sends HEVC brands to libheif', () => {
    for (const brand of ['heic', 'heix', 'mif1']) expect(routeDecoder(ftyp(brand))).toBe('heif');
  });

  it('leaves recognised raster formats and unknown bytes to the browser', () => {
    expect(routeDecoder(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'browser',
    );
    expect(routeDecoder(new Uint8Array(32))).toBe('browser');
  });
});
