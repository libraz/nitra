import { describe, expect, it } from 'vitest';
import { emptyExif, type SourceExif } from '../src/core/io/exif';
import { hasExifFields } from '../src/core/io/exif-write';
import {
  formatCoordinates,
  formatShutter,
  metadataFields,
  parseCoordinates,
  SOFTWARE_NAME,
} from '../src/core/io/metadata';
import { type MetadataParams, neutralRecipe } from '../src/core/recipe/schema';

/** What a photo off a camera arrives carrying. */
function sourceExif(): SourceExif {
  return {
    make: 'Acme',
    model: 'Model 7',
    lens: '35mm f/1.8',
    software: 'CameraOS 4',
    artist: 'Somebody',
    copyright: 'All rights reserved',
    description: 'a street at dusk',
    taken: '2026-09-15T18:42',
    iso: 400,
    fNumber: 2.8,
    exposureTime: 0.004,
    focalLength: 35,
    gps: { latitude: 35.65858, longitude: 139.74543, altitude: 17 },
  };
}

/** A block with every field filled in, so an omission is visible as one. */
function filled(mode: MetadataParams['mode'], patch: Partial<MetadataParams> = {}) {
  const base = neutralRecipe().output.metadata;
  return {
    ...base,
    mode,
    gps: { write: false, latitude: -33.8688, longitude: 151.2093, altitude: 58 },
    capture: {
      write: false,
      taken: '2001-02-03T04:05',
      make: 'Typed',
      model: 'By Hand',
      lens: '50mm',
      iso: 100,
      fNumber: 5.6,
      exposureTime: 0.5,
      focalLength: 50,
    },
    credit: { write: false, artist: 'Typed Artist', copyright: 'CC0', description: 'typed' },
    software: false,
    ...patch,
  } satisfies MetadataParams;
}

const MODES: MetadataParams['mode'][] = ['strip', 'keep', 'custom'];
const FLAGS = [false, true];

describe('resolving what gets written', () => {
  /*
   * Six independent switches decide this, and the interesting failures are the
   * ones where two of them interact — a block that is off still contributing its
   * values, or a mode that ignores a switch it should not. The function is pure
   * and takes microseconds, so every combination is checked rather than a
   * selection of them.
   */
  it('covers every combination of mode, blocks and source', () => {
    let cases = 0;
    for (const mode of MODES) {
      for (const gpsWrite of FLAGS) {
        for (const captureWrite of FLAGS) {
          for (const creditWrite of FLAGS) {
            for (const software of FLAGS) {
              for (const hasSource of FLAGS) {
                cases++;
                const metadata = filled(mode, {
                  gps: { ...filled(mode).gps, write: gpsWrite },
                  capture: { ...filled(mode).capture, write: captureWrite },
                  credit: { ...filled(mode).credit, write: creditWrite },
                  software,
                });
                const source = hasSource ? sourceExif() : null;
                const where = `${mode}/${gpsWrite}/${captureWrite}/${creditWrite}/${software}/${hasSource}`;
                const fields = metadataFields(metadata, source, 1080, 1350);

                if (mode === 'strip') {
                  expect(fields, where).toBeNull();
                  continue;
                }
                if (mode === 'keep') {
                  // Nothing to keep is not an error; it is a photo with no tags.
                  if (!hasSource) {
                    expect(fields, where).toBeNull();
                    continue;
                  }
                  expect(fields?.artist, where).toBe('Somebody');
                  expect(fields?.gps?.latitude, where).toBeCloseTo(35.65858, 6);
                  // The block switches belong to the written mode and must not
                  // reach into this one.
                  expect(fields?.make, where).toBe('Acme');
                  expect(fields?.iso, where).toBe(400);
                  expect(fields?.software, where).toBe(software ? SOFTWARE_NAME : 'CameraOS 4');
                  continue;
                }

                // Written mode: a block that is off contributes nothing, even
                // though its fields still hold what was last typed into them.
                expect(fields, where).not.toBeNull();
                expect(fields?.gps, where).toEqual(
                  gpsWrite ? { latitude: -33.8688, longitude: 151.2093, altitude: 58 } : null,
                );
                expect(fields?.make, where).toBe(captureWrite ? 'Typed' : '');
                expect(fields?.iso, where).toBe(captureWrite ? 100 : 0);
                expect(fields?.taken, where).toBe(captureWrite ? '2001-02-03T04:05' : '');
                expect(fields?.artist, where).toBe(creditWrite ? 'Typed Artist' : '');
                expect(fields?.copyright, where).toBe(creditWrite ? 'CC0' : '');
                expect(fields?.software, where).toBe(software ? SOFTWARE_NAME : '');
                // The open photo has no say in what a written block contains.
                expect(fields?.model, where).not.toBe('Model 7');
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(MODES.length * 2 ** 5);
  });

  it('writes nothing from an untouched recipe, whatever the photo carried', () => {
    const metadata = neutralRecipe().output.metadata;
    expect(metadataFields(metadata, sourceExif(), 100, 100)).toBeNull();
  });

  it('writes nothing from a written block with every switch off', () => {
    // Switching the mode over is not by itself a decision to write anything.
    const fields = metadataFields(filled('custom'), sourceExif(), 100, 100);
    expect(fields).not.toBeNull();
    expect(hasExifFields(fields as NonNullable<typeof fields>)).toBe(false);
  });

  it('carries the exported size, not the photo', () => {
    // A tile is a file in its own right and says its own dimensions.
    const fields = metadataFields(filled('custom', { software: true }), null, 360, 450);
    expect(fields?.width).toBe(360);
    expect(fields?.height).toBe(450);
  });

  it('keeps a photo that carried nothing as a file that carries nothing', () => {
    expect(metadataFields(filled('keep'), emptyExif(), 100, 100)).not.toBeNull();
    const fields = metadataFields(filled('keep'), emptyExif(), 100, 100);
    expect(hasExifFields(fields as NonNullable<typeof fields>)).toBe(false);
  });
});

describe('reading a pasted location', () => {
  it('takes the shape a map puts on the clipboard', () => {
    expect(parseCoordinates('35.65858, 139.74543')).toEqual({
      latitude: 35.65858,
      longitude: 139.74543,
    });
    expect(parseCoordinates(' -33.8688 151.2093 ')).toEqual({
      latitude: -33.8688,
      longitude: 151.2093,
    });
  });

  it('refuses a pair that is not one', () => {
    expect(parseCoordinates('')).toBeNull();
    expect(parseCoordinates('35.6')).toBeNull();
    expect(parseCoordinates('somewhere nice')).toBeNull();
    // Out of range is a typo, not a location on another planet.
    expect(parseCoordinates('135.6, 139.7')).toBeNull();
    expect(parseCoordinates('35.6, 239.7')).toBeNull();
  });
});

describe('reading a number back as a photographer writes it', () => {
  it('writes a fast shutter as a fraction', () => {
    expect(formatShutter(0.004)).toBe('1/250');
    expect(formatShutter(1 / 60)).toBe('1/60');
    expect(formatShutter(2)).toBe('2s');
    expect(formatShutter(0)).toBe('');
  });

  it('shows a coordinate at the precision an address needs', () => {
    expect(formatCoordinates(35.658581234, 139.745431234)).toBe('35.65858, 139.74543');
  });
});
