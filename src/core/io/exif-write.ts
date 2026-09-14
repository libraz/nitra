/**
 * Writing EXIF.
 *
 * nitra only ever writes tags it can also show. There is no pass-through of the
 * source file's metadata block: the fields the panel edits are assembled into a
 * fresh TIFF structure here, so what ends up in the exported file is exactly the
 * list the user was looking at. Copying the original block across would carry the
 * embedded thumbnail — an unedited copy of the photo — and a stale orientation
 * with it, neither of which anyone asked for.
 *
 * Removal still runs first. A file gets a metadata block because it was asked
 * for, never because the encoder left one behind.
 */

import { detectFormat, type ImageFormat } from './strip-metadata';
import { crc32 } from './zip';

/** A location, in signed degrees and metres. */
export interface GpsFix {
  latitude: number;
  longitude: number;
  altitude: number;
}

/** Everything that can be written. Absent and empty both mean "no tag". */
export interface ExifFields {
  make?: string;
  model?: string;
  lens?: string;
  software?: string;
  artist?: string;
  copyright?: string;
  description?: string;
  /** Local date and time as `YYYY-MM-DDTHH:MM`, which is what the field yields. */
  taken?: string;
  iso?: number;
  fNumber?: number;
  /** Shutter speed in seconds. */
  exposureTime?: number;
  /** Focal length in millimetres. */
  focalLength?: number;
  gps?: GpsFix | null;
  /** Pixel dimensions of the exported file, written into the Exif IFD. */
  width?: number;
  height?: number;
}

const BYTE = 1;
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const UNDEFINED = 7;

const TAG_IMAGE_DESCRIPTION = 0x010e;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_SOFTWARE = 0x0131;
const TAG_DATE_TIME = 0x0132;
const TAG_ARTIST = 0x013b;
const TAG_COPYRIGHT = 0x8298;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;

const TAG_XP_TITLE = 0x9c9b;
const TAG_XP_COMMENT = 0x9c9c;
const TAG_XP_AUTHOR = 0x9c9d;

const TAG_EXPOSURE_TIME = 0x829a;
const TAG_F_NUMBER = 0x829d;
const TAG_ISO = 0x8827;
const TAG_EXIF_VERSION = 0x9000;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_DATE_TIME_DIGITIZED = 0x9004;
const TAG_FOCAL_LENGTH = 0x920a;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;
const TAG_LENS_MODEL = 0xa434;

const TAG_GPS_VERSION = 0x0000;
const TAG_GPS_LATITUDE_REF = 0x0001;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LONGITUDE_REF = 0x0003;
const TAG_GPS_LONGITUDE = 0x0004;
const TAG_GPS_ALTITUDE_REF = 0x0005;
const TAG_GPS_ALTITUDE = 0x0006;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** The value in full. Four bytes or fewer sit inside the entry itself. */
  value: Uint8Array;
}

const utf8 = new TextEncoder();

/**
 * An EXIF ASCII string.
 *
 * The specification says ASCII and the field is written as UTF-8 anyway, which
 * is what every camera that has had to spell a European surname does. The
 * Windows XP tags below carry the same text as UTF-16 for readers that only
 * trust those, so a Japanese name survives either way.
 */
function asciiValue(text: string): Uint8Array {
  const body = utf8.encode(text);
  const out = new Uint8Array(body.length + 1);
  out.set(body);
  return out;
}

/** A Windows XP tag: UTF-16LE, NUL terminated, typed as a byte array. */
function ucs2Value(text: string): Uint8Array {
  const out = new Uint8Array((text.length + 1) * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}

function shortValue(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n, true);
  return out;
}

function longValue(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function rationalValue(pairs: readonly (readonly [number, number])[]): Uint8Array {
  const out = new Uint8Array(pairs.length * 8);
  const view = new DataView(out.buffer);
  for (const [i, [numerator, denominator]] of pairs.entries()) {
    view.setUint32(i * 8, Math.max(0, Math.round(numerator)), true);
    view.setUint32(i * 8 + 4, Math.max(1, Math.round(denominator)), true);
  }
  return out;
}

function gcd(a: number, b: number): number {
  let [x, y] = [a, b];
  while (y > 0) [x, y] = [y, x % y];
  return x || 1;
}

/**
 * A positive decimal as a fraction.
 *
 * Reduced rather than left over a fixed denominator so a shutter speed comes
 * back out of the file as `1/250` instead of `4000/1000000`, which is what an
 * exposure readout is expected to say.
 */
export function toRational(value: number): [number, number] {
  if (!Number.isFinite(value) || value <= 0) return [0, 1];
  if (Number.isInteger(value)) return [value, 1];
  const denominator = 1_000_000;
  const numerator = Math.round(value * denominator);
  const divisor = gcd(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}

/** Degrees, minutes and seconds, as EXIF stores an angle. */
function degreesMinutesSeconds(angle: number): [number, number][] {
  const abs = Math.abs(angle);
  const degrees = Math.floor(abs);
  const minutes = Math.floor((abs - degrees) * 60);
  const seconds = (abs - degrees - minutes / 60) * 3600;
  return [
    [degrees, 1],
    [minutes, 1],
    [Math.round(seconds * 10_000), 10_000],
  ];
}

const ASCII_ONLY = /^[ -~]*$/;

function textEntries(tag: number, xpTag: number, text: string): Entry[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const value = asciiValue(trimmed);
  const entries: Entry[] = [{ tag, type: ASCII, count: value.length, value }];
  if (!ASCII_ONLY.test(trimmed)) {
    const wide = ucs2Value(trimmed);
    entries.push({ tag: xpTag, type: BYTE, count: wide.length, value: wide });
  }
  return entries;
}

function plainText(tag: number, text: string): Entry[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const value = asciiValue(trimmed);
  return [{ tag, type: ASCII, count: value.length, value }];
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/** `YYYY-MM-DDTHH:MM` to the `YYYY:MM:DD HH:MM:SS` EXIF spells it with. */
export function exifDateTime(local: string): string | null {
  const match = DATE_TIME.exec(local.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}:${month}:${day} ${hour}:${minute}:${second ?? '00'}`;
}

function buildIfd0(fields: ExifFields): Entry[] {
  const entries: Entry[] = [
    // The pixels were made upright at ingest, so the file says so rather than
    // carrying a rotation a viewer would apply a second time.
    { tag: TAG_ORIENTATION, type: SHORT, count: 1, value: shortValue(1) },
  ];
  entries.push(...textEntries(TAG_IMAGE_DESCRIPTION, TAG_XP_TITLE, fields.description ?? ''));
  entries.push(...plainText(TAG_MAKE, fields.make ?? ''));
  entries.push(...plainText(TAG_MODEL, fields.model ?? ''));
  entries.push(...plainText(TAG_SOFTWARE, fields.software ?? ''));
  entries.push(...textEntries(TAG_ARTIST, TAG_XP_AUTHOR, fields.artist ?? ''));
  entries.push(...textEntries(TAG_COPYRIGHT, TAG_XP_COMMENT, fields.copyright ?? ''));

  const stamp = exifDateTime(fields.taken ?? '');
  if (stamp) entries.push(...plainText(TAG_DATE_TIME, stamp));
  return entries;
}

function buildExifIfd(fields: ExifFields): Entry[] {
  const entries: Entry[] = [];
  const stamp = exifDateTime(fields.taken ?? '');

  if (fields.exposureTime && fields.exposureTime > 0) {
    entries.push({
      tag: TAG_EXPOSURE_TIME,
      type: RATIONAL,
      count: 1,
      value: rationalValue([toRational(fields.exposureTime)]),
    });
  }
  if (fields.fNumber && fields.fNumber > 0) {
    entries.push({
      tag: TAG_F_NUMBER,
      type: RATIONAL,
      count: 1,
      value: rationalValue([toRational(fields.fNumber)]),
    });
  }
  if (fields.iso && fields.iso > 0) {
    entries.push({ tag: TAG_ISO, type: SHORT, count: 1, value: shortValue(fields.iso) });
  }
  if (stamp) {
    entries.push(...plainText(TAG_DATE_TIME_ORIGINAL, stamp));
    entries.push(...plainText(TAG_DATE_TIME_DIGITIZED, stamp));
  }
  if (fields.focalLength && fields.focalLength > 0) {
    entries.push({
      tag: TAG_FOCAL_LENGTH,
      type: RATIONAL,
      count: 1,
      value: rationalValue([toRational(fields.focalLength)]),
    });
  }
  entries.push(...plainText(TAG_LENS_MODEL, fields.lens ?? ''));

  // Nothing above means no Exif IFD. The version tag and the pixel dimensions
  // are bookkeeping that belongs to a block, not a reason to create one — a file
  // whose only metadata is its own size is a file that was given metadata nobody
  // asked for, and the export would then report itself as carrying a block.
  if (entries.length === 0) return [];

  entries.push({ tag: TAG_EXIF_VERSION, type: UNDEFINED, count: 4, value: utf8.encode('0232') });
  if (fields.width && fields.height) {
    entries.push({ tag: TAG_PIXEL_X, type: LONG, count: 1, value: longValue(fields.width) });
    entries.push({ tag: TAG_PIXEL_Y, type: LONG, count: 1, value: longValue(fields.height) });
  }
  return entries;
}

function buildGpsIfd(fields: ExifFields): Entry[] {
  const gps = fields.gps;
  if (!gps) return [];
  const above = gps.altitude >= 0;
  return [
    { tag: TAG_GPS_VERSION, type: BYTE, count: 4, value: Uint8Array.of(2, 3, 0, 0) },
    {
      tag: TAG_GPS_LATITUDE_REF,
      type: ASCII,
      count: 2,
      value: asciiValue(gps.latitude >= 0 ? 'N' : 'S'),
    },
    {
      tag: TAG_GPS_LATITUDE,
      type: RATIONAL,
      count: 3,
      value: rationalValue(degreesMinutesSeconds(gps.latitude)),
    },
    {
      tag: TAG_GPS_LONGITUDE_REF,
      type: ASCII,
      count: 2,
      value: asciiValue(gps.longitude >= 0 ? 'E' : 'W'),
    },
    {
      tag: TAG_GPS_LONGITUDE,
      type: RATIONAL,
      count: 3,
      value: rationalValue(degreesMinutesSeconds(gps.longitude)),
    },
    { tag: TAG_GPS_ALTITUDE_REF, type: BYTE, count: 1, value: Uint8Array.of(above ? 0 : 1) },
    {
      tag: TAG_GPS_ALTITUDE,
      type: RATIONAL,
      count: 1,
      value: rationalValue([toRational(Math.abs(gps.altitude))]),
    },
  ];
}

/** Bytes an IFD occupies: its entries, its terminator, and its value block. */
function ifdSize(entries: readonly Entry[]): number {
  let size = 2 + entries.length * 12 + 4;
  for (const entry of entries) {
    if (entry.value.length > 4) size += entry.value.length + (entry.value.length & 1);
  }
  return size;
}

/**
 * Write one IFD at `base`, with its oversized values in the block behind it.
 *
 * Entries are sorted by tag: a reader is allowed to binary-search an IFD, and an
 * out-of-order tag is the kind of thing that works in one viewer and vanishes in
 * another.
 */
function writeIfd(
  view: DataView,
  bytes: Uint8Array,
  base: number,
  entries: readonly Entry[],
): void {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  view.setUint16(base, sorted.length, true);
  let dataAt = base + 2 + sorted.length * 12 + 4;

  for (const [i, entry] of sorted.entries()) {
    const at = base + 2 + i * 12;
    view.setUint16(at, entry.tag, true);
    view.setUint16(at + 2, entry.type, true);
    view.setUint32(at + 4, entry.count, true);
    if (entry.value.length <= 4) {
      bytes.set(entry.value, at + 8);
    } else {
      view.setUint32(at + 8, dataAt, true);
      bytes.set(entry.value, dataAt);
      dataAt += entry.value.length + (entry.value.length & 1);
    }
  }
  view.setUint32(base + 2 + sorted.length * 12, 0, true);
}

/** True when there is at least one tag worth writing. */
export function hasExifFields(fields: ExifFields): boolean {
  // IFD0 always carries the orientation tag, so it is the other two that decide
  // whether anything was actually asked for — plus any text in IFD0 itself.
  return (
    buildIfd0(fields).length > 1 ||
    buildExifIfd(fields).length > 0 ||
    buildGpsIfd(fields).length > 0
  );
}

/**
 * Assemble the fields into a TIFF block — the payload of an EXIF container.
 *
 * Little-endian throughout. Both byte orders are legal and every reader handles
 * both; picking one and staying with it is what keeps the offsets checkable.
 */
export function buildExifTiff(fields: ExifFields): Uint8Array {
  const exif = buildExifIfd(fields);
  const gps = buildGpsIfd(fields);
  const ifd0 = buildIfd0(fields);

  if (exif.length > 0) {
    ifd0.push({ tag: TAG_EXIF_IFD, type: LONG, count: 1, value: longValue(0) });
  }
  if (gps.length > 0) {
    ifd0.push({ tag: TAG_GPS_IFD, type: LONG, count: 1, value: longValue(0) });
  }

  const exifAt = 8 + ifdSize(ifd0);
  const gpsAt = exifAt + (exif.length > 0 ? ifdSize(exif) : 0);
  const total = gpsAt + (gps.length > 0 ? ifdSize(gps) : 0);

  for (const entry of ifd0) {
    if (entry.tag === TAG_EXIF_IFD) entry.value = longValue(exifAt);
    if (entry.tag === TAG_GPS_IFD) entry.value = longValue(gpsAt);
  }

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);

  writeIfd(view, bytes, 8, ifd0);
  if (exif.length > 0) writeIfd(view, bytes, exifAt, exif);
  if (gps.length > 0) writeIfd(view, bytes, gpsAt, gps);
  return bytes;
}

/** Wrap a TIFF block in the `Exif\0\0` APP1 segment a JPEG carries it in. */
export function exifApp1Segment(tiff: Uint8Array): Uint8Array {
  const payload = new Uint8Array(6 + tiff.length);
  payload.set(utf8.encode('Exif'), 0);
  payload.set(tiff, 6);

  const length = payload.length + 2;
  if (length > 0xffff) throw new Error('EXIF block is too large for one APP1 segment');

  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff;
  out[1] = 0xe1;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Put the APP1 segment straight after the start-of-image marker.
 *
 * Ahead of the encoder's JFIF APP0 rather than behind it: a reader looking for
 * EXIF checks the first segment, and one that only ever finds JFIF there decides
 * the file has no metadata at all.
 */
export function embedExifJpeg(bytes: Uint8Array, tiff: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
  return concat([bytes.subarray(0, 2), exifApp1Segment(tiff), bytes.subarray(2)]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(utf8.encode(type), 4);
  out.set(data, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

/**
 * Add an `eXIf` chunk holding the TIFF block.
 *
 * It goes directly behind the header chunk. The format allows it anywhere before
 * the end, and behind `IHDR` means a reader that stops at the first image data
 * chunk has already seen it.
 */
export function embedExifPng(bytes: Uint8Array, tiff: Uint8Array): Uint8Array {
  if (bytes.length < 16) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(8);
  const afterIhdr = 8 + 12 + headerLength;
  if (afterIhdr > bytes.length) throw new Error('PNG header chunk is truncated');
  return concat([bytes.subarray(0, afterIhdr), pngChunk('eXIf', tiff), bytes.subarray(afterIhdr)]);
}

/** Formats this build can write a metadata block into. */
export function canEmbedExif(format: ImageFormat | null): boolean {
  return format === 'jpeg' || format === 'png';
}

/**
 * Put a metadata block into an encoded image.
 *
 * WebP is refused rather than silently skipped. Carrying EXIF in a WebP means
 * rewriting the container around an extended header, and an export that quietly
 * dropped the location the user typed in would be worse than one that says it
 * cannot.
 */
export function embedExif(bytes: Uint8Array, tiff: Uint8Array): Uint8Array {
  const format = detectFormat(bytes);
  switch (format) {
    case 'jpeg':
      return embedExifJpeg(bytes, tiff);
    case 'png':
      return embedExifPng(bytes, tiff);
    default:
      throw new Error(`cannot write metadata into ${format ?? 'an unrecognised format'}`);
  }
}
