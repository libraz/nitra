/**
 * Synthetic image fixtures.
 *
 * The files built here are not decodable pictures, and do not need to be: what
 * the export path walks is the container, and a container assembled byte by byte
 * is the only way to be sure a GPS tag was actually present before the removal
 * step claimed to have taken it out.
 */

export function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Index of `needle` in `haystack`, or -1. */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff;
  out[1] = marker;
  const length = payload.length + 2;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}

/** Degrees, minutes and hundredths of a second, as EXIF stores an angle. */
export const FIXTURE_LATITUDE = 35 + 41 / 60 + 22.19 / 3600;
export const FIXTURE_LONGITUDE = 139 + 44 / 60 + 43.55 / 3600;

/**
 * A TIFF block carrying an orientation tag and a GPS sub-IFD.
 *
 * Little-endian, with the GPS IFD and its rational data placed after IFD0 so the
 * offsets in the entries are real. The coordinate is complete — a reader is
 * entitled to ignore a latitude that arrives without a longitude, so half a pair
 * would not exercise anything.
 */
export function exifTiffWithGps(orientation = 6): Uint8Array {
  const gpsIfdAt = 38;
  // 2 + four 12-byte entries + the next-IFD pointer.
  const latDataAt = gpsIfdAt + 2 + 4 * 12 + 4;
  const lonDataAt = latDataAt + 24;
  const buffer = new Uint8Array(lonDataAt + 24);
  const view = new DataView(buffer.buffer);

  buffer[0] = 0x49;
  buffer[1] = 0x49; // 'II'
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);

  // IFD0
  view.setUint16(8, 2, true);
  view.setUint16(10, 0x0112, true); // Orientation
  view.setUint16(12, 3, true); // SHORT
  view.setUint32(14, 1, true);
  view.setUint16(18, orientation, true);
  view.setUint16(22, 0x8825, true); // GPSInfoIFDPointer
  view.setUint16(24, 4, true); // LONG
  view.setUint32(26, 1, true);
  view.setUint32(30, gpsIfdAt, true);
  view.setUint32(34, 0, true); // no next IFD

  // GPS IFD
  view.setUint16(gpsIfdAt, 4, true);
  const entry = (n: number) => gpsIfdAt + 2 + n * 12;

  view.setUint16(entry(0), 0x0001, true); // GPSLatitudeRef
  view.setUint16(entry(0) + 2, 2, true); // ASCII
  view.setUint32(entry(0) + 4, 2, true);
  buffer[entry(0) + 8] = 'N'.charCodeAt(0);

  view.setUint16(entry(1), 0x0002, true); // GPSLatitude
  view.setUint16(entry(1) + 2, 5, true); // RATIONAL
  view.setUint32(entry(1) + 4, 3, true);
  view.setUint32(entry(1) + 8, latDataAt, true);

  view.setUint16(entry(2), 0x0003, true); // GPSLongitudeRef
  view.setUint16(entry(2) + 2, 2, true); // ASCII
  view.setUint32(entry(2) + 4, 2, true);
  buffer[entry(2) + 8] = 'E'.charCodeAt(0);

  view.setUint16(entry(3), 0x0004, true); // GPSLongitude
  view.setUint16(entry(3) + 2, 5, true); // RATIONAL
  view.setUint32(entry(3) + 4, 3, true);
  view.setUint32(entry(3) + 8, lonDataAt, true);

  view.setUint32(entry(4), 0, true); // no next IFD

  // 35° 41' 22.19" N — a recognisable coordinate to search the output for.
  view.setUint32(latDataAt, 35, true);
  view.setUint32(latDataAt + 4, 1, true);
  view.setUint32(latDataAt + 8, 41, true);
  view.setUint32(latDataAt + 12, 1, true);
  view.setUint32(latDataAt + 16, 2219, true);
  view.setUint32(latDataAt + 20, 100, true);

  // 139° 44' 43.55" E
  view.setUint32(lonDataAt, 139, true);
  view.setUint32(lonDataAt + 4, 1, true);
  view.setUint32(lonDataAt + 8, 44, true);
  view.setUint32(lonDataAt + 12, 1, true);
  view.setUint32(lonDataAt + 16, 4355, true);
  view.setUint32(lonDataAt + 20, 100, true);

  return buffer;
}

export const ICC_PAYLOAD = concat([
  ascii('ICC_PROFILE\0'),
  Uint8Array.of(1, 1),
  ascii('fake-display-p3-profile-body'),
]);

export interface JpegFixture {
  bytes: Uint8Array;
  tiff: Uint8Array;
  /** The scan, from the SOS marker to the end-of-image marker inclusive. */
  scan: Uint8Array;
}

/**
 * A JPEG carrying everything the export path is supposed to remove: EXIF with
 * GPS, a JFIF thumbnail, a Photoshop block, a comment, and data appended past
 * the end-of-image marker.
 */
export function jpegWithMetadata(): JpegFixture {
  const tiff = exifTiffWithGps();

  const jfif = concat([
    ascii('JFIF\0'),
    Uint8Array.of(1, 2, 1, 0, 72, 0, 72, 2, 2),
    // A 2x2 RGB thumbnail: an unedited copy of the photo, in miniature.
    new Uint8Array(12).fill(0x7f),
  ]);

  const scan = concat([
    Uint8Array.of(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00),
    Uint8Array.of(0x12, 0x34, 0xff, 0x00, 0x56, 0x78, 0xff, 0xd0, 0x9a),
    Uint8Array.of(0xff, 0xd9),
  ]);

  const bytes = concat([
    Uint8Array.of(0xff, 0xd8),
    segment(0xe0, jfif),
    segment(0xe1, concat([ascii('Exif\0\0'), tiff])),
    segment(0xe2, ICC_PAYLOAD),
    segment(0xed, concat([ascii('Photoshop 3.0\0'), ascii('8BIM')])),
    segment(0xfe, ascii('shot with a camera that knows where it was')),
    segment(0xdb, concat([Uint8Array.of(0), new Uint8Array(64).fill(16)])),
    segment(0xc0, Uint8Array.of(8, 0, 16, 0, 16, 1, 1, 0x11, 0)),
    segment(0xc4, Uint8Array.of(0, ...new Array(16).fill(0), 0)),
    scan,
    ascii('trailing junk that came along for the ride'),
  ]);

  return { bytes, tiff, scan };
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  // The CRC is not recomputed: nothing under test reads it, and a wrong value
  // would be caught by the round-trip assertion if a kept chunk were rewritten.
  view.setUint32(8 + data.length, 0x12345678);
  return out;
}

export function pngWithMetadata(): Uint8Array {
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0)),
    pngChunk('iCCP', concat([ascii('p3\0'), Uint8Array.of(0), ascii('profile')])),
    pngChunk('eXIf', exifTiffWithGps()),
    pngChunk('tEXt', ascii('Author\0someone')),
    pngChunk('iTXt', ascii('XML:com.adobe.xmp\0')),
    pngChunk('tIME', Uint8Array.of(0x07, 0xe9, 1, 2, 3, 4, 5)),
    pngChunk('IDAT', ascii('not really deflate')),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const padded = data.length + (data.length & 1);
  const out = new Uint8Array(8 + padded);
  out.set(ascii(fourcc), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

export function webpWithMetadata(): Uint8Array {
  const body = concat([
    // VP8X flags: ICC, EXIF and XMP all advertised.
    riffChunk('VP8X', Uint8Array.of(0b0010_1100, 0, 0, 0, 15, 0, 0, 15, 0, 0)),
    riffChunk('ICCP', ascii('fake-profile')),
    riffChunk('VP8 ', ascii('not really a bitstream')),
    riffChunk('EXIF', exifTiffWithGps()),
    riffChunk('XMP ', ascii('<x:xmpmeta/>')),
  ]);
  const header = new Uint8Array(12);
  header.set(ascii('RIFF'), 0);
  new DataView(header.buffer).setUint32(4, 4 + body.length, true);
  header.set(ascii('WEBP'), 8);
  return concat([header, body]);
}

/**
 * A JPEG with no metadata in it at all.
 *
 * This is the shape a canvas encoder produces once the removal step has run, and
 * therefore the shape anything that writes a metadata block has to start from.
 */
export function cleanJpeg(): Uint8Array {
  return concat([
    Uint8Array.of(0xff, 0xd8),
    segment(0xdb, concat([Uint8Array.of(0), new Uint8Array(64).fill(16)])),
    segment(0xc0, Uint8Array.of(8, 0, 16, 0, 16, 1, 1, 0x11, 0)),
    Uint8Array.of(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00),
    Uint8Array.of(0x12, 0x34, 0x56, 0x78),
    Uint8Array.of(0xff, 0xd9),
  ]);
}

/** A PNG with no metadata chunks, for the same reason. */
export function cleanPng(): Uint8Array {
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0)),
    pngChunk('IDAT', ascii('not really deflate')),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}
