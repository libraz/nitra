import { describe, expect, it } from 'vitest';
import {
  emptyExif,
  isEmptyExif,
  orientationMatrix,
  orientationSwapsAxes,
  readExifFromTiff,
  readImageExif,
  readImageOrientation,
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

/** A little-endian TIFF whose IFD0 holds the given tags, values stored behind it. */
function tiffWithTags(tags: { tag: number; type: number; count: number; data: Uint8Array }[]) {
  const head = 8 + 2 + tags.length * 12 + 4;
  const total = head + tags.reduce((n, t) => n + (t.data.length > 4 ? t.data.length : 0), 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, tags.length, true);
  let dataAt = head;
  for (const [i, t] of tags.entries()) {
    const at = 10 + i * 12;
    view.setUint16(at, t.tag, true);
    view.setUint16(at + 2, t.type, true);
    view.setUint32(at + 4, t.count, true);
    if (t.data.length <= 4) {
      out.set(t.data, at + 8);
      continue;
    }
    view.setUint32(at + 8, dataAt, true);
    out.set(t.data, dataAt);
    dataAt += t.data.length;
  }
  return out;
}

function ascii0(text: string) {
  return { type: 2, count: text.length + 1, data: Uint8Array.of(...ascii(text), 0) };
}

function ucs2(text: string) {
  const data = new Uint8Array((text.length + 1) * 2);
  for (let i = 0; i < text.length; i++)
    new DataView(data.buffer).setUint16(i * 2, text.charCodeAt(i), true);
  return { type: 1, count: data.length, data };
}

describe('standard tags outrank the Windows XP duplicates', () => {
  it('reads copyright, artist and description from their standard tags when both exist', () => {
    const exif = readExifFromTiff(
      tiffWithTags([
        { tag: 0x010e, ...ascii0('real description') },
        { tag: 0x013b, ...ascii0('real artist') },
        { tag: 0x8298, ...ascii0('real copyright') },
        { tag: 0x9c9b, ...ucs2('xp title') },
        { tag: 0x9c9c, ...ucs2('private comment') },
        { tag: 0x9c9d, ...ucs2('xp author') },
      ]),
    );
    expect(exif.description).toBe('real description');
    expect(exif.artist).toBe('real artist');
    expect(exif.copyright).toBe('real copyright');
  });

  it('falls back to an XP tag only when the standard one is absent or empty', () => {
    const exif = readExifFromTiff(
      tiffWithTags([
        { tag: 0x8298, ...ascii0('') },
        { tag: 0x9c9b, ...ucs2('xp title') },
        { tag: 0x9c9c, ...ucs2('fallback') },
      ]),
    );
    expect(exif.copyright).toBe('fallback');
    expect(exif.description).toBe('xp title');
  });
});

describe('orientation transform', () => {
  // Where the stored top-left, top-right and bottom-left corners land, as
  // [x, y] in units of the upright frame, for each of EXIF orientations 1-8.
  const expected: Record<number, [number[], number[], number[]]> = {
    1: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
    2: [
      [1, 0],
      [0, 0],
      [1, 1],
    ],
    3: [
      [1, 1],
      [0, 1],
      [1, 0],
    ],
    4: [
      [0, 1],
      [1, 1],
      [0, 0],
    ],
    5: [
      [0, 0],
      [0, 1],
      [1, 0],
    ],
    6: [
      [1, 0],
      [1, 1],
      [0, 0],
    ],
    7: [
      [1, 1],
      [1, 0],
      [0, 1],
    ],
    8: [
      [0, 1],
      [0, 0],
      [1, 1],
    ],
  };

  it('puts the stored corners where the EXIF specification says, for all eight', () => {
    const storedW = 4;
    const storedH = 2;
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const swap = orientationSwapsAxes(o);
      const outW = swap ? storedH : storedW;
      const outH = swap ? storedW : storedH;
      const [a, b, c, d, tx, ty] = orientationMatrix(o);
      const map = (x: number, y: number) => [
        (a * x + c * y + tx * outW) / outW,
        (b * x + d * y + ty * outH) / outH,
      ];
      const [tl, tr, bl] = expected[o] as [number[], number[], number[]];
      expect(map(0, 0), `orientation ${o} top-left`).toEqual(tl);
      expect(map(storedW, 0), `orientation ${o} top-right`).toEqual(tr);
      expect(map(0, storedH), `orientation ${o} bottom-left`).toEqual(bl);
    }
  });
});

describe('orientation in every container that carries it', () => {
  it('reads the tag from JPEG, PNG and WebP', () => {
    expect(readImageOrientation(jpegWithMetadata().bytes)).toBe(6);
    expect(readImageOrientation(pngWithMetadata())).toBe(6);
    expect(readImageOrientation(webpWithMetadata())).toBe(6);
  });

  it('is upright for anything else', () => {
    expect(readImageOrientation(cleanJpeg())).toBe(1);
    expect(readImageOrientation(ascii('nothing'))).toBe(1);
  });
});

describe('malformed input', () => {
  const sources = {
    jpeg: jpegWithMetadata().bytes,
    png: pngWithMetadata(),
    webp: webpWithMetadata(),
  };

  it('never throws on any truncation of a container', () => {
    for (const [name, bytes] of Object.entries(sources)) {
      for (let n = 0; n <= bytes.length; n++) {
        const cut = bytes.subarray(0, n);
        expect(() => readImageExif(cut), `${name} ${n}`).not.toThrow();
        expect(() => readImageOrientation(cut), `${name} ${n}`).not.toThrow();
        expect(() => readJpegOrientation(cut), `${name} ${n}`).not.toThrow();
      }
    }
  });

  it('never throws on a TIFF block cut anywhere or corrupted at any byte', () => {
    const tiff = exifTiffWithGps();
    for (let n = 0; n <= tiff.length; n++) {
      expect(() => readExifFromTiff(tiff.subarray(0, n))).not.toThrow();
      expect(() => readOrientationFromTiff(tiff.subarray(0, n))).not.toThrow();
    }
    for (const fill of [0x00, 0xff, 0x7f]) {
      for (let at = 0; at < tiff.length; at++) {
        const bad = tiff.slice();
        bad[at] = fill;
        expect(() => readExifFromTiff(bad), `${fill} at ${at}`).not.toThrow();
        expect(() => readOrientationFromTiff(bad), `${fill} at ${at}`).not.toThrow();
      }
    }
  });

  it('survives entry counts, offsets and type codes pointing outside the block', () => {
    const base = exifTiffWithGps();
    const view = (b: Uint8Array) => new DataView(b.buffer);
    const huge = base.slice();
    view(huge).setUint32(4, 0xffff_fff0, true);
    const count = base.slice();
    view(count).setUint16(8, 0xffff, true);
    const type = base.slice();
    view(type).setUint16(10 + 2, 99, true);
    for (const bad of [huge, count, type]) {
      expect(() => readExifFromTiff(bad)).not.toThrow();
      expect(() => readOrientationFromTiff(bad)).not.toThrow();
    }
  });

  it('keeps a GPS fix in range, or drops it, when a denominator is zero', () => {
    const tiff = exifTiffWithGps();
    const view = new DataView(tiff.buffer);
    // Zero every rational denominator the fixture wrote.
    for (let at = 0; at + 8 <= tiff.length; at++) {
      const bytes = tiff.slice();
      new DataView(bytes.buffer).setUint32(at, 0, true);
      const gps = readExifFromTiff(bytes).gps;
      if (gps) {
        expect(Math.abs(gps.latitude)).toBeLessThanOrEqual(90);
        expect(Math.abs(gps.longitude)).toBeLessThanOrEqual(180);
        expect(Number.isFinite(gps.altitude)).toBe(true);
      }
    }
    expect(view.byteLength).toBeGreaterThan(0);
  });
});
