/**
 * The archive is read by whatever the operating system opens a .zip with, so the
 * assertions are made against the produced bytes and the offsets recorded inside
 * them rather than against the writer's own view of what it wrote.
 */

import { describe, expect, it } from 'vitest';
import { buildZip, crc32, type ZipEntry } from '../src/core/io/zip';
import { ascii, indexOfBytes } from './helpers/images';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const END_SIZE = 22;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface EndRecord {
  at: number;
  entries: number;
  centralSize: number;
  centralAt: number;
}

/** The end-of-central-directory record, which sits last when there is no comment. */
function endRecord(zip: Uint8Array): EndRecord {
  const at = zip.length - END_SIZE;
  const v = view(zip);
  return {
    at,
    entries: v.getUint16(at + 10, true),
    centralSize: v.getUint32(at + 12, true),
    centralAt: v.getUint32(at + 16, true),
  };
}

interface CentralRecord {
  at: number;
  crc: number;
  nameLength: number;
  name: string;
  localAt: number;
}

/** Walk the central directory as an extractor would, from the end record outwards. */
function centralRecords(zip: Uint8Array): CentralRecord[] {
  const v = view(zip);
  const end = endRecord(zip);
  const records: CentralRecord[] = [];
  let at = end.centralAt;
  for (let i = 0; i < end.entries; i++) {
    const nameLength = v.getUint16(at + 28, true);
    const extraLength = v.getUint16(at + 30, true);
    const commentLength = v.getUint16(at + 32, true);
    records.push({
      at,
      crc: v.getUint32(at + 16, true),
      nameLength,
      name: new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength)),
      localAt: v.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}

const sample: ZipEntry[] = [
  {
    name: 'photo-01.jpg',
    data: ascii('first payload'),
    modified: new Date(2024, 4, 17, 9, 30, 44),
  },
  { name: 'exports/photo-02.png', data: Uint8Array.from({ length: 300 }, (_, i) => i & 0xff) },
];

describe('crc32', () => {
  it('matches the published check vectors', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
    expect(crc32(ascii('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('returns an unsigned value', () => {
    // The running remainder is signed after the shifts, and a negative number
    // written into the CRC field makes the entry unreadable.
    expect(crc32(ascii('a'))).toBe(0xe8b7be43);
  });
});

describe('archive structure', () => {
  it('opens with a local header and closes with the end record', () => {
    const zip = buildZip(sample);
    expect(view(zip).getUint32(0, true)).toBe(LOCAL_SIGNATURE);
    expect(view(zip).getUint32(zip.length - END_SIZE, true)).toBe(END_SIGNATURE);
  });

  it('points its end record at the real central directory', () => {
    const zip = buildZip(sample);
    const end = endRecord(zip);
    expect(end.entries).toBe(sample.length);
    expect(view(zip).getUint32(end.centralAt, true)).toBe(CENTRAL_SIGNATURE);
    // The recorded size has to span exactly the records, or an extractor reading
    // the directory by length walks into the end record.
    expect(end.centralAt + end.centralSize).toBe(end.at);
  });

  it('records a local header offset that lands on a local header', () => {
    const zip = buildZip(sample);
    for (const record of centralRecords(zip)) {
      expect(view(zip).getUint32(record.localAt, true), record.name).toBe(LOCAL_SIGNATURE);
    }
  });

  it('names the entries it was given, in order', () => {
    const zip = buildZip(sample);
    expect(centralRecords(zip).map((r) => r.name)).toEqual(sample.map((e) => e.name));
  });
});

describe('stored entries', () => {
  it('keeps the payload bytes verbatim', () => {
    // Store-only is the whole point: the bytes handed in are the bytes an
    // extractor gets back, with no decompression step in between.
    const zip = buildZip(sample);
    for (const entry of sample) {
      expect(indexOfBytes(zip, entry.data), entry.name).toBeGreaterThan(0);
    }
  });

  it('writes a CRC the payload actually has', () => {
    const zip = buildZip(sample);
    const records = centralRecords(zip);
    for (let i = 0; i < sample.length; i++) {
      const entry = sample[i] as ZipEntry;
      const record = records[i] as CentralRecord;
      const expected = crc32(entry.data);
      // Both copies of the field are checked; an extractor may read either.
      expect(view(zip).getUint32(record.localAt + 14, true), entry.name).toBe(expected);
      expect(record.crc, entry.name).toBe(expected);
    }
  });

  it('reports the stored size as both compressed and uncompressed', () => {
    const zip = buildZip(sample);
    const records = centralRecords(zip);
    for (let i = 0; i < sample.length; i++) {
      const entry = sample[i] as ZipEntry;
      const record = records[i] as CentralRecord;
      expect(view(zip).getUint32(record.localAt + 18, true)).toBe(entry.data.length);
      expect(view(zip).getUint32(record.localAt + 22, true)).toBe(entry.data.length);
    }
  });
});

describe('file names', () => {
  it('round-trips a name that is not ASCII', () => {
    const name = '写真/夏の記録.jpg';
    const zip = buildZip([{ name, data: ascii('body') }]);
    const encoded = utf8(name);
    expect(indexOfBytes(zip, encoded)).toBeGreaterThan(0);

    const record = centralRecords(zip)[0] as CentralRecord;
    expect(record.name).toBe(name);
    // The length field counts bytes; taking it from the string would truncate
    // the name and push every following field out of place.
    expect(record.nameLength).toBe(encoded.length);
    expect(record.nameLength).toBeGreaterThan(name.length);
    expect(view(zip).getUint16(record.localAt + 26, true)).toBe(encoded.length);
  });

  it('flags the name as UTF-8', () => {
    const zip = buildZip([{ name: '写真.jpg', data: ascii('body') }]);
    // Without bit 11 the name is read as CP437 and arrives as mojibake.
    expect(view(zip).getUint16(6, true) & 0x0800).toBe(0x0800);
  });

  it('refuses a name that could write outside the extraction directory', () => {
    for (const name of ['', '/abs.txt', 'a/../../b.txt']) {
      expect(() => buildZip([{ name, data: ascii('body') }])).toThrow();
    }
  });
});

describe('edge cases', () => {
  it('writes a valid archive for no entries at all', () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(END_SIZE);
    const end = endRecord(zip);
    expect(view(zip).getUint32(0, true)).toBe(END_SIGNATURE);
    expect(end.entries).toBe(0);
    expect(end.centralSize).toBe(0);
    expect(end.centralAt).toBe(0);
  });

  it('stores an empty payload', () => {
    const zip = buildZip([{ name: 'empty.bin', data: new Uint8Array(0) }]);
    const record = centralRecords(zip)[0] as CentralRecord;
    expect(record.crc).toBe(0);
    expect(view(zip).getUint32(record.localAt + 22, true)).toBe(0);
  });

  it('floors a pre-1980 date instead of writing a negative year', () => {
    const zip = buildZip([
      { name: 'old.txt', data: ascii('body'), modified: new Date(1972, 2, 3, 4, 5, 6) },
    ]);
    const record = centralRecords(zip)[0] as CentralRecord;
    const date = view(zip).getUint16(record.localAt + 12, true);
    expect(date >> 9).toBe(0); // 1980
    expect((date >> 5) & 0x0f).toBe(1); // January
    expect(date & 0x1f).toBe(1); // the first
  });

  it('encodes the given time in DOS fields', () => {
    const zip = buildZip(sample);
    const record = centralRecords(zip)[0] as CentralRecord;
    const v = view(zip);
    const time = v.getUint16(record.localAt + 10, true);
    const date = v.getUint16(record.localAt + 12, true);
    expect(date >> 9).toBe(2024 - 1980);
    expect((date >> 5) & 0x0f).toBe(5);
    expect(date & 0x1f).toBe(17);
    expect(time >> 11).toBe(9);
    expect((time >> 5) & 0x3f).toBe(30);
    // Seconds are held in two-second units, so an odd second rounds down.
    expect((time & 0x1f) * 2).toBe(44);
  });
});
