/**
 * EXIF reading.
 *
 * Orientation is applied to the pixels at ingest and then discarded, so every
 * stage after ingest can assume the image is upright.
 *
 * The rest is read so the metadata panel can show what the photo arrived
 * carrying, and so it can be copied into the export when that is what the user
 * wants. Reading it changes nothing about removal: what leaves the browser is
 * decided by the recipe, and the default is still that none of this goes with it.
 */

import { APP1, jpegSegments, payloadStartsWith } from './jpeg';
import { detectFormat } from './strip-metadata';

/** EXIF orientation, 1 (upright) through 8. */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const TAG_ORIENTATION = 0x0112;

/** Orientations that exchange width and height. */
export function orientationSwapsAxes(o: Orientation): boolean {
  return o >= 5;
}

/**
 * The transform that takes stored pixels to upright, as a 2x3 affine in
 * normalised image space: `[a, b, c, d, tx, ty]`.
 */
export function orientationMatrix(
  o: Orientation,
): [number, number, number, number, number, number] {
  switch (o) {
    case 1:
      return [1, 0, 0, 1, 0, 0];
    case 2:
      return [-1, 0, 0, 1, 1, 0];
    case 3:
      return [-1, 0, 0, -1, 1, 1];
    case 4:
      return [1, 0, 0, -1, 0, 1];
    case 5:
      return [0, 1, 1, 0, 0, 0];
    case 6:
      return [0, 1, -1, 0, 1, 0];
    case 7:
      return [0, -1, -1, 0, 1, 1];
    case 8:
      return [0, -1, 1, 0, 0, 1];
  }
}

/** Locate the TIFF header inside a JPEG's `Exif\0\0` APP1 segment. */
export function findExifTiff(bytes: Uint8Array): Uint8Array | null {
  for (const seg of jpegSegments(bytes)) {
    if (seg.marker !== APP1) continue;
    if (!payloadStartsWith(seg.payload, 'Exif\0\0')) continue;
    return seg.payload.subarray(6);
  }
  return null;
}

/**
 * Read the orientation tag out of a TIFF block.
 *
 * Deliberately separate from {@link readExifFromTiff} and deliberately
 * forgiving: ingest needs this one tag out of files that are routinely truncated
 * or malformed, and it has to give an answer rather than fail.
 */
export function readOrientationFromTiff(tiff: Uint8Array): Orientation {
  if (tiff.length < 8) return 1;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return 1;

  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, le) !== 42) return 1;
  const ifd0 = view.getUint32(4, le);
  if (ifd0 + 2 > tiff.length) return 1;

  const count = view.getUint16(ifd0, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (view.getUint16(entry, le) !== TAG_ORIENTATION) continue;
    const value = view.getUint16(entry + 8, le);
    return value >= 1 && value <= 8 ? (value as Orientation) : 1;
  }
  return 1;
}

/** Read orientation from a JPEG, defaulting to upright when it is absent. */
export function readJpegOrientation(bytes: Uint8Array): Orientation {
  try {
    const tiff = findExifTiff(bytes);
    return tiff ? readOrientationFromTiff(tiff) : 1;
  } catch {
    return 1;
  }
}

/* ------------------------------------------------------------------ tags */

/** What the photo arrived carrying, in the shape the metadata panel edits. */
export interface SourceExif {
  make: string;
  model: string;
  lens: string;
  software: string;
  artist: string;
  copyright: string;
  description: string;
  /** Local date and time as `YYYY-MM-DDTHH:MM`, or empty when absent. */
  taken: string;
  iso: number;
  fNumber: number;
  /** Shutter speed in seconds. */
  exposureTime: number;
  /** Focal length in millimetres. */
  focalLength: number;
  gps: { latitude: number; longitude: number; altitude: number } | null;
}

export function emptyExif(): SourceExif {
  return {
    make: '',
    model: '',
    lens: '',
    software: '',
    artist: '',
    copyright: '',
    description: '',
    taken: '',
    iso: 0,
    fNumber: 0,
    exposureTime: 0,
    focalLength: 0,
    gps: null,
  };
}

/** True when the file carried nothing worth showing. */
export function isEmptyExif(exif: SourceExif): boolean {
  return (
    exif.make === '' &&
    exif.model === '' &&
    exif.lens === '' &&
    exif.software === '' &&
    exif.artist === '' &&
    exif.copyright === '' &&
    exif.description === '' &&
    exif.taken === '' &&
    exif.iso === 0 &&
    exif.fNumber === 0 &&
    exif.exposureTime === 0 &&
    exif.focalLength === 0 &&
    exif.gps === null
  );
}

type TagValue = string | number[] | Uint8Array;

/** Bytes one component of each TIFF type occupies, indexed by the type code. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function decodeAscii(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return utf8Decoder.decode(end < 0 ? bytes : bytes.subarray(0, end)).trim();
}

/** A Windows XP tag, which is UTF-16LE held in a byte array. */
function decodeUcs2(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = (bytes[i] as number) | ((bytes[i + 1] as number) << 8);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

/**
 * Read the entries of one IFD.
 *
 * Offsets inside a TIFF block are measured from the start of that block, which
 * is why the block is passed around rather than the whole file.
 */
function readIfd(tiff: Uint8Array, at: number, le: boolean): Map<number, TagValue> {
  const out = new Map<number, TagValue>();
  if (at + 2 > tiff.length) return out;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const count = view.getUint16(at, le);

  for (let i = 0; i < count; i++) {
    const entry = at + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    const tag = view.getUint16(entry, le);
    const type = view.getUint16(entry + 2, le);
    const length = view.getUint32(entry + 4, le);
    const size = TYPE_SIZE[type];
    if (!size || length > 0xffff) continue;

    const total = size * length;
    const from = total <= 4 ? entry + 8 : view.getUint32(entry + 8, le);
    if (from + total > tiff.length) continue;
    const raw = tiff.subarray(from, from + total);

    if (type === 2) {
      out.set(tag, decodeAscii(raw));
    } else if (type === 1 || type === 7) {
      out.set(tag, raw);
    } else {
      const values: number[] = [];
      for (let k = 0; k < length; k++) {
        const off = from + k * size;
        switch (type) {
          case 3:
            values.push(view.getUint16(off, le));
            break;
          case 4:
            values.push(view.getUint32(off, le));
            break;
          case 5:
            values.push(view.getUint32(off, le) / (view.getUint32(off + 4, le) || 1));
            break;
          case 8:
            values.push(view.getInt16(off, le));
            break;
          case 9:
            values.push(view.getInt32(off, le));
            break;
          case 10:
            values.push(view.getInt32(off, le) / (view.getInt32(off + 4, le) || 1));
            break;
          default:
            break;
        }
      }
      out.set(tag, values);
    }
  }
  return out;
}

function text(ifd: Map<number, TagValue>, tag: number): string {
  const value = ifd.get(tag);
  return typeof value === 'string' ? value : '';
}

function wide(ifd: Map<number, TagValue>, tag: number): string {
  const value = ifd.get(tag);
  return value instanceof Uint8Array ? decodeUcs2(value) : '';
}

function numeric(ifd: Map<number, TagValue>, tag: number): number {
  const value = ifd.get(tag);
  if (!Array.isArray(value) || value.length === 0) return 0;
  const first = value[0] as number;
  return Number.isFinite(first) ? first : 0;
}

const EXIF_STAMP = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/;

/** `YYYY:MM:DD HH:MM:SS` back to what a date-time field takes. */
function localDateTime(stamp: string): string {
  const match = stamp.match(EXIF_STAMP);
  if (!match) return '';
  const [, year, month, day, hour, minute] = match;
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/** Degrees, minutes and seconds back to a signed decimal degree. */
function decimalDegrees(parts: TagValue | undefined, ref: string): number | null {
  if (!Array.isArray(parts) || parts.length < 3) return null;
  const [degrees = 0, minutes = 0, seconds = 0] = parts;
  const magnitude = degrees + minutes / 60 + seconds / 3600;
  if (!Number.isFinite(magnitude)) return null;
  return ref === 'S' || ref === 'W' ? -magnitude : magnitude;
}

/**
 * Pull the editable tags out of a TIFF block.
 *
 * Only the tags the panel can show are read. A tag outside this list is not held
 * anywhere, which keeps "nitra writes only what it shows you" true from both
 * directions.
 */
export function readExifFromTiff(tiff: Uint8Array): SourceExif {
  const out = emptyExif();
  if (tiff.length < 8) return out;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return out;

  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, le) !== 42) return out;

  const ifd0 = readIfd(tiff, view.getUint32(4, le), le);
  out.description = wide(ifd0, 0x9c9b) || text(ifd0, 0x010e);
  out.make = text(ifd0, 0x010f);
  out.model = text(ifd0, 0x0110);
  out.software = text(ifd0, 0x0131);
  out.artist = wide(ifd0, 0x9c9d) || text(ifd0, 0x013b);
  out.copyright = wide(ifd0, 0x9c9c) || text(ifd0, 0x8298);
  out.taken = localDateTime(text(ifd0, 0x0132));

  const exifPointer = numeric(ifd0, 0x8769);
  if (exifPointer > 0) {
    const exif = readIfd(tiff, exifPointer, le);
    out.exposureTime = numeric(exif, 0x829a);
    out.fNumber = numeric(exif, 0x829d);
    out.iso = numeric(exif, 0x8827) || numeric(exif, 0x8833);
    out.focalLength = numeric(exif, 0x920a);
    out.lens = text(exif, 0xa434);
    // The capture time in the Exif IFD is the one the camera fills in; the IFD0
    // stamp is often the time the file was last written by an editor.
    out.taken = localDateTime(text(exif, 0x9003)) || out.taken;
  }

  const gpsPointer = numeric(ifd0, 0x8825);
  if (gpsPointer > 0) {
    const gps = readIfd(tiff, gpsPointer, le);
    const latitude = decimalDegrees(gps.get(0x0002), text(gps, 0x0001));
    const longitude = decimalDegrees(gps.get(0x0004), text(gps, 0x0003));
    if (latitude !== null && longitude !== null) {
      const below = (gps.get(0x0005) as Uint8Array | undefined)?.[0] === 1;
      const altitude = numeric(gps, 0x0006);
      out.gps = { latitude, longitude, altitude: below ? -altitude : altitude };
    }
  }
  return out;
}

/** The `eXIf` chunk of a PNG, which holds a bare TIFF block. */
function findPngTiff(bytes: Uint8Array): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const end = pos + 12 + length;
    if (end > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (type === 'eXIf') return bytes.subarray(pos + 8, pos + 8 + length);
    if (type === 'IEND') return null;
    pos = end;
  }
  return null;
}

/** The `EXIF` chunk of a WebP, which holds a bare TIFF block. */
function findWebpTiff(bytes: Uint8Array): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(...bytes.subarray(pos, pos + 4));
    const size = view.getUint32(pos + 4, true);
    const end = pos + 8 + size + (size & 1);
    if (end > bytes.length) return null;
    if (fourcc === 'EXIF') return bytes.subarray(pos + 8, pos + 8 + size);
    pos = end;
  }
  return null;
}

/**
 * Read the editable tags from an encoded image.
 *
 * Every format that can carry a metadata block is checked, not only JPEG: a
 * photo exported from another editor as PNG or WebP still has a location in it,
 * and a panel that showed nothing for those would be reporting that it is safe.
 */
export function readImageExif(bytes: Uint8Array): SourceExif {
  try {
    const format = detectFormat(bytes);
    const tiff =
      format === 'jpeg'
        ? findExifTiff(bytes)
        : format === 'png'
          ? findPngTiff(bytes)
          : format === 'webp'
            ? findWebpTiff(bytes)
            : null;
    return tiff ? readExifFromTiff(tiff) : emptyExif();
  } catch {
    return emptyExif();
  }
}
