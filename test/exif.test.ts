import { describe, expect, it } from 'vitest';
import {
  emptyExif,
  isEmptyExif,
  orientationMatrix,
  orientationSwapsAxes,
  readImageExif,
  readJpegOrientation,
  readOrientationFromTiff,
} from '../src/core/io/exif';
import {
  ascii,
  cleanJpeg,
  exifTiffWithGps,
  FIXTURE_LATITUDE,
  FIXTURE_LONGITUDE,
  jpegWithMetadata,
  pngWithMetadata,
  webpWithMetadata,
} from './helpers/images';

/** Rebuild the fixture's TIFF block as big-endian. */
function toBigEndian(tiff: Uint8Array): Uint8Array {
  const out = new Uint8Array(tiff);
  const src = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const dst = new DataView(out.buffer);
  out[0] = 0x4d;
  out[1] = 0x4d;
  dst.setUint16(2, 42, false);
  dst.setUint32(4, src.getUint32(4, true), false);
  const count = src.getUint16(8, true);
  dst.setUint16(8, count, false);
  for (let i = 0; i < count; i++) {
    const at = 10 + i * 12;
    dst.setUint16(at, src.getUint16(at, true), false);
    dst.setUint16(at + 2, src.getUint16(at + 2, true), false);
    dst.setUint32(at + 4, src.getUint32(at + 4, true), false);
    dst.setUint16(at + 8, src.getUint16(at + 8, true), false);
    dst.setUint16(at + 10, src.getUint16(at + 10, true), false);
  }
  return out;
}

describe('orientation', () => {
  it('reads the tag out of a little-endian block', () => {
    expect(readOrientationFromTiff(exifTiffWithGps(6))).toBe(6);
  });

  it('reads the tag out of a big-endian block', () => {
    expect(readOrientationFromTiff(toBigEndian(exifTiffWithGps(8)))).toBe(8);
  });

  it('reads the tag out of a JPEG', () => {
    expect(readJpegOrientation(jpegWithMetadata().bytes)).toBe(6);
  });

  it('assumes upright when there is no tag to read', () => {
    // Every stage after ingest assumes the image is upright, so an unreadable
    // tag has to resolve to a defined answer rather than propagate.
    expect(readJpegOrientation(ascii('not a JPEG at all'))).toBe(1);
    expect(readOrientationFromTiff(new Uint8Array(4))).toBe(1);
    expect(readOrientationFromTiff(ascii('IInot-a-tiff'))).toBe(1);
  });

  it('rejects an out-of-range tag value', () => {
    const tiff = exifTiffWithGps(1);
    new DataView(tiff.buffer).setUint16(18, 99, true);
    expect(readOrientationFromTiff(tiff)).toBe(1);
  });

  it('knows which orientations exchange the axes', () => {
    expect([1, 2, 3, 4].map((o) => orientationSwapsAxes(o as 1))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect([5, 6, 7, 8].map((o) => orientationSwapsAxes(o as 5))).toEqual([true, true, true, true]);
  });

  it('describes each orientation as a transform that is its own inverse in pairs', () => {
    // Applying the matrix twice returns to the start for every flip and for the
    // 180-degree rotation; that is the cheap check that none of them is a typo.
    for (const o of [1, 2, 3, 4, 5, 7] as const) {
      const [a, b, c, d] = orientationMatrix(o);
      const twice = [a * a + b * c, a * b + b * d, c * a + d * c, c * b + d * d];
      expect(twice.map((v) => Math.round(v) + 0)).toEqual([1, 0, 0, 1]);
    }
  });
});

describe('reading the editable tags', () => {
  it('finds the block in every container that can carry one', () => {
    // A photo exported from another editor as PNG or WebP still has a location
    // in it. A panel that showed nothing for those would be saying it is safe.
    for (const [name, bytes] of [
      ['jpeg', jpegWithMetadata().bytes],
      ['png', pngWithMetadata()],
      ['webp', webpWithMetadata()],
    ] as const) {
      const exif = readImageExif(bytes);
      expect(exif.gps, name).not.toBeNull();
      expect(exif.gps?.latitude, name).toBeCloseTo(FIXTURE_LATITUDE, 6);
      expect(exif.gps?.longitude, name).toBeCloseTo(FIXTURE_LONGITUDE, 6);
    }
  });

  it('reports nothing rather than failing on a file it cannot walk', () => {
    expect(isEmptyExif(readImageExif(ascii('not an image')))).toBe(true);
    expect(isEmptyExif(readImageExif(new Uint8Array(0)))).toBe(true);
    // A JPEG that carries no metadata block is the normal case after an export.
    expect(isEmptyExif(readImageExif(cleanJpeg()))).toBe(true);
  });

  it('calls an untouched set of tags empty', () => {
    expect(isEmptyExif(emptyExif())).toBe(true);
    expect(isEmptyExif({ ...emptyExif(), iso: 100 })).toBe(false);
    expect(isEmptyExif({ ...emptyExif(), artist: 'somebody' })).toBe(false);
  });
});
