import { describe, expect, it } from 'vitest';
import { readExifFromTiff, readImageExif } from '../src/core/io/exif';
import {
  buildExifTiff,
  type ExifFields,
  embedExif,
  embedExifJpeg,
  embedExifPng,
  exifDateTime,
  hasExifFields,
  toRational,
} from '../src/core/io/exif-write';
import { crc32 } from '../src/core/io/zip';
import { cleanJpeg, cleanPng, webpWithMetadata } from './helpers/images';

/** The tags of one IFD, in the order they were written. */
function tagsOf(tiff: Uint8Array, at: number): number[] {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const count = view.getUint16(at, true);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(view.getUint16(at + 2 + i * 12, true));
  return out;
}

/** The value of one tag in an IFD, as a LONG. */
function longTag(tiff: Uint8Array, at: number, tag: number): number | null {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const count = view.getUint16(at, true);
  for (let i = 0; i < count; i++) {
    const entry = at + 2 + i * 12;
    if (view.getUint16(entry, true) === tag) return view.getUint32(entry + 8, true);
  }
  return null;
}

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;

describe('fractions', () => {
  it('reduces a shutter speed to the fraction it is written as', () => {
    // 4000/1000000 is the same number, and is not what an exposure reads as.
    expect(toRational(0.004)).toEqual([1, 250]);
    expect(toRational(2.8)).toEqual([14, 5]);
    expect(toRational(35)).toEqual([35, 1]);
  });

  it('refuses to invent a fraction for a value that has none', () => {
    expect(toRational(0)).toEqual([0, 1]);
    expect(toRational(-1)).toEqual([0, 1]);
    expect(toRational(Number.NaN)).toEqual([0, 1]);
  });
});

describe('date stamps', () => {
  it('converts what the field yields into what EXIF spells', () => {
    expect(exifDateTime('2026-09-15T18:42')).toBe('2026:09:15 18:42:00');
    expect(exifDateTime('2026-09-15T18:42:07')).toBe('2026:09:15 18:42:07');
  });

  it('writes no stamp rather than a wrong one', () => {
    expect(exifDateTime('')).toBeNull();
    expect(exifDateTime('yesterday')).toBeNull();
    expect(exifDateTime('2026-09-15')).toBeNull();
  });
});

describe('deciding whether to write at all', () => {
  it('treats an empty set of fields as nothing to write', () => {
    // Orientation alone is not a reason to give a file a metadata block.
    expect(hasExifFields({})).toBe(false);
    expect(hasExifFields({ make: '', artist: '   ', gps: null })).toBe(false);
  });

  it('counts any single field', () => {
    expect(hasExifFields({ artist: 'somebody' })).toBe(true);
    expect(hasExifFields({ iso: 400 })).toBe(true);
    expect(hasExifFields({ gps: { latitude: 0, longitude: 0, altitude: 0 } })).toBe(true);
  });
});

describe('building a metadata block', () => {
  const fields: ExifFields = {
    make: 'Acme',
    model: 'Model 7',
    lens: '35mm f/1.8',
    software: 'nitra',
    artist: 'Somebody',
    copyright: 'All rights reserved',
    description: 'a street at dusk',
    taken: '2026-09-15T18:42',
    iso: 400,
    fNumber: 2.8,
    exposureTime: 0.004,
    focalLength: 35,
    gps: { latitude: 35.65858, longitude: 139.74543, altitude: 17 },
    width: 1080,
    height: 1350,
  };

  it('reads back everything that was written', () => {
    const back = readExifFromTiff(buildExifTiff(fields));
    expect(back.make).toBe('Acme');
    expect(back.model).toBe('Model 7');
    expect(back.lens).toBe('35mm f/1.8');
    expect(back.software).toBe('nitra');
    expect(back.artist).toBe('Somebody');
    expect(back.copyright).toBe('All rights reserved');
    expect(back.description).toBe('a street at dusk');
    expect(back.taken).toBe('2026-09-15T18:42');
    expect(back.iso).toBe(400);
    expect(back.fNumber).toBeCloseTo(2.8, 6);
    expect(back.exposureTime).toBeCloseTo(0.004, 8);
    expect(back.focalLength).toBeCloseTo(35, 6);
    expect(back.gps?.latitude).toBeCloseTo(35.65858, 6);
    expect(back.gps?.longitude).toBeCloseTo(139.74543, 6);
    expect(back.gps?.altitude).toBeCloseTo(17, 4);
  });

  it('keeps every IFD sorted by tag', () => {
    // A reader is allowed to binary-search an IFD. An out-of-order tag is the
    // kind of fault that works in one viewer and vanishes in another.
    const tiff = buildExifTiff(fields);
    const ifd0 = tagsOf(tiff, 8);
    expect(ifd0).toEqual([...ifd0].sort((a, b) => a - b));

    const exifAt = longTag(tiff, 8, TAG_EXIF_IFD);
    const gpsAt = longTag(tiff, 8, TAG_GPS_IFD);
    expect(exifAt).not.toBeNull();
    expect(gpsAt).not.toBeNull();

    for (const at of [exifAt as number, gpsAt as number]) {
      const tags = tagsOf(tiff, at);
      expect(tags.length).toBeGreaterThan(0);
      expect(tags).toEqual([...tags].sort((a, b) => a - b));
    }
  });

  it('points the sub-IFDs at offsets inside the block', () => {
    const tiff = buildExifTiff(fields);
    for (const tag of [TAG_EXIF_IFD, TAG_GPS_IFD]) {
      const at = longTag(tiff, 8, tag) as number;
      expect(at).toBeGreaterThan(8);
      expect(at).toBeLessThan(tiff.length);
    }
  });

  it('says the picture is upright, because the pixels already are', () => {
    // Orientation was applied at ingest. Writing the source's value back would
    // have a viewer rotate an image that has already been rotated.
    const tiff = buildExifTiff(fields);
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const count = view.getUint16(8, true);
    let orientation: number | null = null;
    for (let i = 0; i < count; i++) {
      const entry = 10 + i * 12;
      if (view.getUint16(entry, true) === 0x0112) orientation = view.getUint16(entry + 8, true);
    }
    expect(orientation).toBe(1);
  });

  it('writes only the groups it was given', () => {
    const tiff = buildExifTiff({ artist: 'Somebody' });
    expect(longTag(tiff, 8, TAG_GPS_IFD)).toBeNull();
    expect(longTag(tiff, 8, TAG_EXIF_IFD)).toBeNull();
    const back = readExifFromTiff(tiff);
    expect(back.artist).toBe('Somebody');
    expect(back.gps).toBeNull();
    expect(back.iso).toBe(0);
  });
});

describe('coordinates', () => {
  it('carries the sign through the hemisphere reference', () => {
    // Degrees are stored unsigned with a letter beside them, so a dropped sign
    // puts the photo in the wrong hemisphere rather than off by a little.
    const south = readExifFromTiff(
      buildExifTiff({ gps: { latitude: -33.8688, longitude: -70.6693, altitude: 0 } }),
    );
    expect(south.gps?.latitude).toBeCloseTo(-33.8688, 6);
    expect(south.gps?.longitude).toBeCloseTo(-70.6693, 6);
  });

  it('carries an altitude below sea level', () => {
    const below = readExifFromTiff(
      buildExifTiff({ gps: { latitude: 31.5, longitude: 35.5, altitude: -413 } }),
    );
    expect(below.gps?.altitude).toBeCloseTo(-413, 4);
  });

  it('keeps the equator and the meridian on the positive side', () => {
    const origin = readExifFromTiff(
      buildExifTiff({ gps: { latitude: 0, longitude: 0, altitude: 0 } }),
    );
    expect(origin.gps?.latitude).toBe(0);
    expect(origin.gps?.longitude).toBe(0);
  });
});

describe('text outside the Latin alphabet', () => {
  it('survives the round trip', () => {
    const back = readExifFromTiff(
      buildExifTiff({ artist: '山田太郎', copyright: '© 二〇二六', description: '夕暮れの通り' }),
    );
    expect(back.artist).toBe('山田太郎');
    expect(back.copyright).toBe('© 二〇二六');
    expect(back.description).toBe('夕暮れの通り');
  });

  it('is written twice, so a reader that only trusts one encoding still gets it', () => {
    const tiff = buildExifTiff({ artist: '山田太郎' });
    const tags = tagsOf(tiff, 8);
    expect(tags).toContain(0x013b); // Artist, as bytes
    expect(tags).toContain(0x9c9d); // XPAuthor, as UTF-16
  });

  it('writes plain ASCII once', () => {
    const tags = tagsOf(buildExifTiff({ artist: 'Somebody' }), 8);
    expect(tags).toContain(0x013b);
    expect(tags).not.toContain(0x9c9d);
  });
});

describe('putting the block into a file', () => {
  const fields: ExifFields = {
    artist: 'Somebody',
    gps: { latitude: 51.5007, longitude: -0.1246, altitude: 5 },
  };

  it('puts the JPEG segment ahead of everything else', () => {
    // A reader that checks the first segment and finds JFIF there concludes the
    // file has no metadata at all.
    const out = embedExifJpeg(cleanJpeg(), buildExifTiff(fields));
    expect([out[0], out[1]]).toEqual([0xff, 0xd8]);
    expect([out[2], out[3]]).toEqual([0xff, 0xe1]);

    const back = readImageExif(out);
    expect(back.artist).toBe('Somebody');
    expect(back.gps?.latitude).toBeCloseTo(51.5007, 6);
    expect(back.gps?.longitude).toBeCloseTo(-0.1246, 6);
  });

  it('leaves the JPEG scan untouched', () => {
    const clean = cleanJpeg();
    const out = embedExifJpeg(clean, buildExifTiff(fields));
    const added = out.length - clean.length;
    expect(added).toBeGreaterThan(0);
    // Everything from the original after the SOI is still there, in order.
    expect([...out.subarray(2 + added)]).toEqual([...clean.subarray(2)]);
  });

  it('gives the PNG chunk a correct checksum', () => {
    // A wrong CRC is a chunk every decoder is entitled to throw away, and one
    // that several will reject the whole file over.
    const out = embedExifPng(cleanPng(), buildExifTiff(fields));
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const at = 8 + 12 + 13; // behind the signature and IHDR
    const length = view.getUint32(at);
    const type = String.fromCharCode(...out.subarray(at + 4, at + 8));
    expect(type).toBe('eXIf');
    expect(view.getUint32(at + 8 + length)).toBe(crc32(out.subarray(at + 4, at + 8 + length)));

    expect(readImageExif(out).artist).toBe('Somebody');
  });

  it('refuses a format it cannot write, rather than dropping the block', () => {
    // Silently exporting without the location someone typed in would be worse
    // than saying it cannot be done.
    expect(() => embedExif(webpWithMetadata(), buildExifTiff(fields))).toThrow(/webp/);
    expect(() => embedExif(Uint8Array.of(1, 2, 3, 4), buildExifTiff(fields))).toThrow();
  });
});
