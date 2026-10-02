// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fontByKey,
  loadFontFile,
  missingFontKeys,
  missingGlyphs,
  unloadFont,
} from '../src/core/text/fonts';
import { DEFAULT_WEIGHT, weightChoices } from '../src/core/text/weights';

/** A browser's font set, reduced to what the catalogue touches. */
function stubFontMachinery() {
  const live = new Set<unknown>();
  class StubFace {
    constructor(
      readonly family: string,
      readonly source: ArrayBuffer,
    ) {}
    async load() {}
  }
  vi.stubGlobal('FontFace', StubFace);
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add: (face: unknown) => live.add(face),
      delete: (face: unknown) => live.delete(face),
      ready: Promise.resolve(),
    },
  });
  return live;
}

function fontFile(name: string, bytes: number[]): File {
  return new File([new Uint8Array(bytes)], name);
}

describe('a supplied face across loads', () => {
  let live: Set<unknown>;
  beforeEach(() => {
    live = stubFontMachinery();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a key bound to the file it was made from, whatever else was loaded first', async () => {
    const a = fontFile('Face.ttf', [1, 2, 3]);
    const b = fontFile('Other.ttf', [9, 9, 9]);

    const first = await loadFontFile(a);
    unloadFont(first.key);
    // A different face now loads where a count of loaded faces would have
    // handed it the first one's name.
    const other = await loadFontFile(b);
    expect(other.key).not.toBe(first.key);
    expect(missingFontKeys([first.key])).toEqual([first.key]);

    const again = await loadFontFile(a);
    expect(again.key).toBe(first.key);
    expect(fontByKey(first.key)?.stack).toContain(again.stack.split(',')[0]);
    unloadFont(other.key);
    unloadFont(again.key);
  });

  it('gives two different files of the same name two keys', async () => {
    const one = await loadFontFile(fontFile('Face.ttf', [1]));
    const two = await loadFontFile(fontFile('Face.ttf', [2]));
    expect(one.key).not.toBe(two.key);
    unloadFont(one.key);
    unloadFont(two.key);
  });

  it('takes the face back out of the document when it is unloaded', async () => {
    const face = await loadFontFile(fontFile('Face.ttf', [5, 5]));
    expect(live.size).toBe(1);
    unloadFont(face.key);
    expect(live.size).toBe(0);
  });
});

describe('characters a supplied face is said to lack', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never names one that has no width to miss', async () => {
    stubFontMachinery();
    const face = await loadFontFile(fontFile('Face.ttf', [7]));
    const family = face.stack.split(',')[0] ?? '';
    // The fallback and the face agree on everything, so a nonzero advance would
    // be reported; a zero one must not be.
    const context = {
      font: '',
      measureText: (char: string) => ({ width: char === '​' ? 0 : 10 }),
    };
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'canvas'
        ? ({ getContext: () => context } as unknown as HTMLCanvasElement)
        : create(tag)) as typeof document.createElement);
    expect(family).not.toBe('');
    expect(missingGlyphs('a​', face.key)).toEqual(['a']);
    vi.restoreAllMocks();
    unloadFont(face.key);
  });
});

describe('the weights the caption panel offers', () => {
  it('includes the weight a new caption starts with', () => {
    expect(weightChoices(500)).toContain(DEFAULT_WEIGHT);
  });

  it('still offers it after another weight is picked, and shows any weight in force', () => {
    expect(weightChoices(700)).toContain(DEFAULT_WEIGHT);
    expect(weightChoices(650)).toContain(650);
    expect(weightChoices(650)).toEqual([...weightChoices(650)].sort((x, y) => x - y));
  });
});
