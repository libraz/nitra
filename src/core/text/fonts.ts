/**
 * The typefaces captions are set in.
 *
 * Two things are settled here. Which faces exist is data rather than a switch
 * statement, so adding one is adding an entry. And a face the user supplies
 * themselves is the same kind of thing as a built-in one — it goes in the same
 * list, is picked the same way, and the recipe refers to it by the same kind of
 * key.
 *
 * A supplied face carries a real risk the built-ins do not: a display face drawn
 * for Latin has no kana in it, and a caption typed in Japanese comes out as
 * empty boxes in the export with nothing on screen having looked wrong. So the
 * app stack is kept behind every custom face as a fallback, and the characters
 * the face could not draw are reported rather than left to be discovered in the
 * file.
 */

/** A font offered in the picker. */
export interface FontDescriptor {
  key: string;
  /** CSS font stack, most specific first. */
  stack: string;
  /**
   * Name to show. Built-in faces leave this empty and are named by the message
   * catalogue instead; a supplied face is named after the file it came from.
   */
  label: string;
  /** Weights the face actually ships. Anything else is synthesised. */
  weights: readonly number[];
  /** True when the user loaded it from their own machine. */
  custom: boolean;
}

/** Faces the app itself can reach, in the order the picker lists them. */
const BUILT_IN: readonly FontDescriptor[] = [
  {
    key: 'sans',
    stack: '"IBM Plex Sans", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif',
    label: '',
    weights: [300, 400, 500, 600, 700],
    custom: false,
  },
  {
    key: 'serif',
    stack: '"Hiragino Mincho ProN", "Noto Serif JP", "Yu Mincho", Georgia, serif',
    label: '',
    weights: [400, 600],
    custom: false,
  },
  {
    key: 'rounded',
    stack: '"Hiragino Maru Gothic ProN", "M PLUS Rounded 1c", Avenir, sans-serif',
    label: '',
    weights: [400, 500, 700],
    custom: false,
  },
  {
    key: 'mono',
    stack: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    label: '',
    weights: [400, 500, 600],
    custom: false,
  },
  {
    key: 'condensed',
    stack:
      '"Helvetica Neue Condensed", "Avenir Next Condensed", "Roboto Condensed", "Hiragino Sans", sans-serif',
    label: '',
    weights: [400, 600, 700],
    custom: false,
  },
  {
    key: 'display',
    stack: '"Hiragino Sans W8", "Impact", "Haettenschweiler", "Noto Sans JP", sans-serif',
    label: '',
    weights: [700, 900],
    custom: false,
  },
];

/** The stack every caption falls back to, custom faces included. */
const FALLBACK_STACK = BUILT_IN[0]?.stack ?? 'sans-serif';

export const DEFAULT_FONT = BUILT_IN[0] as FontDescriptor;

const custom = new Map<string, FontDescriptor>();

/** Every face the picker can offer right now. */
export function allFonts(): readonly FontDescriptor[] {
  return [...BUILT_IN, ...custom.values()];
}

export function customFonts(): readonly FontDescriptor[] {
  return [...custom.values()];
}

export function fontByKey(key: string): FontDescriptor | undefined {
  return BUILT_IN.find((font) => font.key === key) ?? custom.get(key);
}

/**
 * The CSS stack for a key.
 *
 * An unknown key resolves to the default rather than failing. A recipe that
 * names a face the user has not loaded on this machine still renders — as the
 * wrong face, which {@link missingFontKeys} is there to say out loud.
 */
export function fontStack(key: string): string {
  return (fontByKey(key) ?? DEFAULT_FONT).stack;
}

/** Keys used by these layers that no loaded face answers to. */
export function missingFontKeys(keys: readonly string[]): string[] {
  const missing = new Set<string>();
  for (const key of keys) {
    if (!fontByKey(key)) missing.add(key);
  }
  return [...missing];
}

/**
 * A CSS family name that cannot collide with a real one.
 *
 * Only the internal handle is reduced to ASCII; the name shown in the picker is
 * the file's own, so a Japanese font keeps its Japanese name on screen.
 */
function familyFor(stem: string): string {
  const cleaned = stem.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-');
  return `nitra-user-${cleaned || 'font'}-${custom.size + 1}`;
}

const FONT_FILE = /\.(otf|ttf|woff2?|ttc)$/i;

/** True when a file is one this build can hand to the browser as a face. */
export function isFontFile(file: File): boolean {
  return FONT_FILE.test(file.name) || file.type.startsWith('font/');
}

/**
 * Register a face from the user's own machine.
 *
 * The file is read into an `ArrayBuffer` and handed to the browser's font
 * machinery, so it never leaves the device any more than the photo does. It also
 * does not survive a reload: a recipe can name the face, but the file has to be
 * picked again, which the panel says rather than silently substituting.
 */
export async function loadFontFile(file: File): Promise<FontDescriptor> {
  if (typeof FontFace === 'undefined' || !document.fonts) {
    throw new Error('this browser cannot load a font file');
  }
  const stem = file.name.replace(/\.[^.]+$/, '');
  const family = familyFor(stem);
  const face = new FontFace(family, await file.arrayBuffer());
  await face.load();
  document.fonts.add(face);

  const descriptor: FontDescriptor = {
    key: `user:${family}`,
    // The app stack sits behind it so a caption still reads when the face is
    // missing a character, instead of coming out as a row of boxes.
    stack: `"${family}", ${FALLBACK_STACK}`,
    label: stem,
    weights: [400],
    custom: true,
  };
  custom.set(descriptor.key, descriptor);
  return descriptor;
}

/** Forget a supplied face. The recipe may still name it; the panel will say so. */
export function unloadFont(key: string): void {
  custom.delete(key);
}

let probe: CanvasRenderingContext2D | null | undefined;

function probeContext(): CanvasRenderingContext2D | null {
  if (probe !== undefined) return probe;
  probe = document.createElement('canvas').getContext('2d');
  return probe;
}

/** A family name no font has, so anything measured against it is the fallback. */
const ABSENT_FAMILY = '"nitra-no-such-face"';

function widthIn(ctx: CanvasRenderingContext2D, char: string, family: string): number {
  ctx.font = `72px ${family}`;
  return ctx.measureText(char).width;
}

/**
 * Characters the face itself cannot draw, in first-seen order.
 *
 * Measured rather than read out of the font's character map, because the browser
 * never hands the map over. A character is called missing when setting it in the
 * face alone measures exactly as it does in a family that does not exist: both
 * ran the same substitution, so the face supplied nothing.
 *
 * That is a width comparison, so two glyphs of identical advance could in
 * principle be confused — it is the wrong answer in a direction that under-
 * reports, never one that invents a problem. Only supplied faces are checked;
 * a built-in stack ends in a generic family and covers everything by
 * construction.
 */
export function missingGlyphs(text: string, key: string): string[] {
  const font = fontByKey(key);
  if (!font?.custom) return [];
  const ctx = probeContext();
  if (!ctx) return [];

  // The bare family, without the fallback the stack normally carries.
  const family = font.stack.split(',')[0]?.trim() ?? '';
  if (!family) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const char of text) {
    if (seen.has(char) || /\s/.test(char)) continue;
    seen.add(char);
    if (widthIn(ctx, char, family) === widthIn(ctx, char, ABSENT_FAMILY)) out.push(char);
  }
  return out;
}

/**
 * Wait for every face the app ships and every face the user has supplied.
 *
 * Type drawn before its face has arrived is type drawn in the fallback, and the
 * fallback is what would be baked into the export.
 */
export function fontsReady(): Promise<unknown> {
  return document.fonts?.ready ?? Promise.resolve();
}
