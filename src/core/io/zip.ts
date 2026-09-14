/**
 * Store-only ZIP writer.
 *
 * What goes into one of these archives is exported photos, and JPEG, PNG and
 * WebP payloads are already compressed: running DEFLATE over them would spend
 * seconds of the same main thread the preview renders on and give back close to
 * nothing. Every entry is therefore stored verbatim, which also keeps the writer
 * small enough to carry no dependency — a compressor would be the largest thing
 * in the bundle and it would earn none of its weight.
 */

export interface ZipEntry {
  /** Path inside the archive. Forward slashes only, no leading slash. */
  name: string;
  data: Uint8Array;
  /** Modification time written into the entry. Defaults to the current time. */
  modified?: Date;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

/** Fixed part of each record; the file name follows the local and central ones. */
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const END_SIZE = 22;

/** Extract version 2.0, the floor for a stored entry with no extended features. */
const VERSION = 20;

/** General purpose bit 11: the file name is UTF-8 rather than CP437. */
const FLAG_UTF8 = 0x0800;

/** Compression method 0 — stored. */
const STORED = 0;

/** MS-DOS date fields count years from here and cannot express anything earlier. */
const DOS_EPOCH_YEAR = 1980;

let crcTable: Uint32Array | null = null;

/**
 * The byte-wise CRC table, built on first use.
 *
 * A session that never bundles an export never builds it.
 */
function table(): Uint32Array {
  if (crcTable) return crcTable;
  const built = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    built[i] = c;
  }
  crcTable = built;
  return built;
}

/** CRC-32 (IEEE 802.3 polynomial), as used by the ZIP format. */
export function crc32(data: Uint8Array): number {
  const lookup = table();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (lookup[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  // The sign bit survives the shifts, and the field is unsigned.
  return (crc ^ 0xffffffff) >>> 0;
}

interface DosTimestamp {
  date: number;
  time: number;
}

/**
 * Split an instant into the packed MS-DOS date and time fields.
 *
 * Local time, which is what the format has always meant by these fields.
 * Anything before 1980 would encode as a negative year and read back as a date
 * decades in the future, so it is floored at the epoch instead.
 */
function dosTimestamp(when: Date): DosTimestamp {
  if (!Number.isFinite(when.getTime()) || when.getFullYear() < DOS_EPOCH_YEAR) {
    return { date: (1 << 5) | 1, time: 0 };
  }
  return {
    date:
      ((when.getFullYear() - DOS_EPOCH_YEAR) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    // Seconds go in two-second units; that is the resolution the format has.
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
  };
}

/**
 * Reject a name that could place the entry outside the extraction directory.
 *
 * Extractors differ on how much of this they defend against, and the one the
 * archive lands in is not ours to choose, so nothing that resolves upwards is
 * written in the first place.
 */
function checkName(name: string): void {
  if (name.length === 0) throw new Error('zip entry name is empty');
  if (name.startsWith('/')) throw new Error(`zip entry name is absolute: ${name}`);
  if (name.split('/').includes('..')) {
    throw new Error(`zip entry name escapes the archive: ${name}`);
  }
}

interface PreparedEntry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  stamp: DosTimestamp;
}

/** Build a ZIP archive containing `entries`, stored without compression. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared: PreparedEntry[] = entries.map((entry) => {
    checkName(entry.name);
    return {
      name: encoder.encode(entry.name),
      data: entry.data,
      crc: crc32(entry.data),
      stamp: dosTimestamp(entry.modified ?? new Date()),
    };
  });

  // Sized up front rather than grown by concatenation: the payloads are whole
  // photos, and every reallocation would copy all of them again.
  let total = END_SIZE;
  for (const entry of prepared) {
    total += LOCAL_SIZE + CENTRAL_SIZE + entry.name.length * 2 + entry.data.length;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (value: number): void => {
    view.setUint16(at, value, true);
    at += 2;
  };
  const u32 = (value: number): void => {
    view.setUint32(at, value, true);
    at += 4;
  };
  const raw = (value: Uint8Array): void => {
    out.set(value, at);
    at += value.length;
  };

  const localOffsets: number[] = [];
  for (const entry of prepared) {
    localOffsets.push(at);
    u32(LOCAL_SIGNATURE);
    u16(VERSION);
    u16(FLAG_UTF8);
    u16(STORED);
    u16(entry.stamp.time);
    u16(entry.stamp.date);
    u32(entry.crc);
    u32(entry.data.length); // compressed size, which for a stored entry is the same
    u32(entry.data.length);
    u16(entry.name.length);
    u16(0); // extra field length
    raw(entry.name);
    raw(entry.data);
  }

  const centralAt = at;
  for (let i = 0; i < prepared.length; i++) {
    const entry = prepared[i] as PreparedEntry;
    u32(CENTRAL_SIGNATURE);
    u16(VERSION); // version made by, host system 0 (MS-DOS)
    u16(VERSION);
    u16(FLAG_UTF8);
    u16(STORED);
    u16(entry.stamp.time);
    u16(entry.stamp.date);
    u32(entry.crc);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(entry.name.length);
    u16(0); // extra field length
    u16(0); // file comment length
    u16(0); // disk number start
    u16(0); // internal file attributes
    u32(0); // external file attributes
    u32(localOffsets[i] as number);
    raw(entry.name);
  }

  const centralSize = at - centralAt;
  u32(END_SIGNATURE);
  u16(0); // number of this disk
  u16(0); // disk holding the start of the central directory
  u16(prepared.length);
  u16(prepared.length);
  u32(centralSize);
  u32(centralAt);
  u16(0); // archive comment length

  return out;
}
