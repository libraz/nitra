/**
 * Turning the recipe's metadata block into the tags that get written.
 *
 * Kept apart from both the schema and the encoder so the decision is testable on
 * its own: this is where "remove everything" stays the meaning of an untouched
 * recipe, and where a block that is switched off contributes nothing even though
 * its fields still hold whatever was last typed into them.
 */

import type { MetadataParams } from '../recipe/schema';
import type { SourceExif } from './exif';
import type { ExifFields } from './exif-write';

/** What nitra calls itself in a file it produced. */
export const SOFTWARE_NAME = 'nitra';

/**
 * Resolve the block against the photo that was opened.
 *
 * Returns null when nothing is to be written, which is the case an untouched
 * recipe produces and the one the export path treats as "removed".
 */
export function metadataFields(
  metadata: MetadataParams,
  source: SourceExif | null,
  width: number,
  height: number,
): ExifFields | null {
  const software = metadata.software ? SOFTWARE_NAME : '';

  if (metadata.mode === 'strip') return null;

  if (metadata.mode === 'keep') {
    // Nothing to keep is not an error: plenty of photos arrive with no metadata
    // at all, and the export is then the same file either way.
    if (!source) return null;
    return {
      make: source.make,
      model: source.model,
      lens: source.lens,
      software: software || source.software,
      artist: source.artist,
      copyright: source.copyright,
      description: source.description,
      taken: source.taken,
      iso: source.iso,
      fNumber: source.fNumber,
      exposureTime: source.exposureTime,
      focalLength: source.focalLength,
      gps: source.gps,
      width,
      height,
    };
  }

  const { capture, credit, gps } = metadata;
  return {
    make: capture.write ? capture.make : '',
    model: capture.write ? capture.model : '',
    lens: capture.write ? capture.lens : '',
    software,
    artist: credit.write ? credit.artist : '',
    copyright: credit.write ? credit.copyright : '',
    description: credit.write ? credit.description : '',
    taken: capture.write ? capture.taken : '',
    iso: capture.write ? capture.iso : 0,
    fNumber: capture.write ? capture.fNumber : 0,
    exposureTime: capture.write ? capture.exposureTime : 0,
    focalLength: capture.write ? capture.focalLength : 0,
    gps: gps.write
      ? { latitude: gps.latitude, longitude: gps.longitude, altitude: gps.altitude }
      : null,
    width,
    height,
  };
}

/** A shutter speed as a photographer writes it: `1/250` below a second. */
export function formatShutter(seconds: number): string {
  if (seconds <= 0) return '';
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}s`;
  return `1/${Math.round(1 / seconds)}`;
}

/** A coordinate pair, at the precision a street address needs and no more. */
export function formatCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

const COORDINATE_PAIR = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

/**
 * Read a pasted coordinate pair.
 *
 * Pasting `35.6586, 139.7454` straight out of a map is how a location actually
 * gets entered; typing it into two separate number fields is not.
 */
export function parseCoordinates(input: string): { latitude: number; longitude: number } | null {
  const match = input.match(COORDINATE_PAIR);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}
