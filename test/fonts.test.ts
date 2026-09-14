import { describe, expect, it } from 'vitest';
import {
  allFonts,
  DEFAULT_FONT,
  fontByKey,
  fontStack,
  isFontFile,
  missingFontKeys,
  missingGlyphs,
} from '../src/core/text/fonts';

/** The families a browser resolves without consulting any font file. */
const GENERIC = ['sans-serif', 'serif', 'monospace', 'system-ui', 'cursive', 'fantasy'];

describe('the catalogue', () => {
  it('offers the built-in faces and names each one once', () => {
    const keys = allFonts().map((font) => font.key);
    expect(keys).toContain('sans');
    expect(keys).toContain('serif');
    expect(keys).toContain('mono');
    expect(keys).toContain('rounded');
    expect(keys).toContain('condensed');
    expect(keys).toContain('display');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ends every built-in stack in a family the browser always has', () => {
    // This is what makes the coverage check unnecessary for a built-in: the last
    // entry answers for any character the ones before it cannot draw.
    for (const font of allFonts().filter((f) => !f.custom)) {
      const last = font.stack.split(',').at(-1)?.trim() ?? '';
      expect(GENERIC, font.key).toContain(last);
    }
  });

  it('starts on a face that is there', () => {
    expect(fontByKey(DEFAULT_FONT.key)).toBeDefined();
    expect(DEFAULT_FONT.custom).toBe(false);
  });
});

describe('a key that no face answers to', () => {
  it('still renders, in the default face', () => {
    // A recipe naming a typeface loaded on somebody else's machine has to open.
    expect(fontStack('user:nitra-user-something-1')).toBe(DEFAULT_FONT.stack);
    expect(fontStack('')).toBe(DEFAULT_FONT.stack);
  });

  it('is reported, so the substitution is not silent', () => {
    expect(missingFontKeys(['sans', 'user:gone', 'serif'])).toEqual(['user:gone']);
    expect(missingFontKeys(['user:gone', 'user:gone'])).toEqual(['user:gone']);
    expect(missingFontKeys(['sans', 'mono'])).toEqual([]);
  });
});

describe('checking a face for the characters it has to draw', () => {
  it('leaves built-in stacks alone', () => {
    // They fall back through to a generic family, so nothing is ever missing.
    expect(missingGlyphs('漢字とかなとAaと🙂', 'sans')).toEqual([]);
    expect(missingGlyphs('漢字', 'display')).toEqual([]);
  });

  it('says nothing about a face it does not have', () => {
    expect(missingGlyphs('漢字', 'user:gone')).toEqual([]);
  });
});

describe('recognising a font file', () => {
  it('takes the extensions a face actually ships as', () => {
    for (const name of ['Face.ttf', 'Face.otf', 'Face.woff', 'Face.woff2', 'Face.TTC']) {
      expect(isFontFile(new File([], name)), name).toBe(true);
    }
  });

  it('turns away a file that is not one', () => {
    expect(isFontFile(new File([], 'photo.jpg'))).toBe(false);
    expect(isFontFile(new File([], 'notes.txt'))).toBe(false);
  });

  it('believes the media type when the name carries no extension', () => {
    expect(isFontFile(new File([], 'download', { type: 'font/ttf' }))).toBe(true);
  });
});
