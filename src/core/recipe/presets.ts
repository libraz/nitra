/**
 * Finishes, and the dial that scales them.
 *
 * A finish is picked by looking at the user's own photo rendered through it, not
 * by reading its name, so what is defined here is only the numbers. The caption
 * under each thumbnail is looked up from the message catalogue by `key`.
 */

import type { FaceParams, GlobalParams } from './schema';

export interface Look {
  key: string;
  params: Partial<GlobalParams>;
  /**
   * What the finish does to a face, when there is one.
   *
   * Carried separately because it is separately applicable: the same finish has
   * to be a complete answer on a photograph of a person and on a photograph of
   * a street, and on the street the block is simply never reached. A finish
   * with no entry here is one that has nothing to say about skin.
   */
  face?: Partial<FaceParams>;
}

/** Strength the finishes below are written at; the dial stretches around it. */
export const REFERENCE_STRENGTH = 0.55;

export const LOOKS: readonly Look[] = [
  {
    key: 'natural',
    params: {
      exposure: 0.05,
      contrast: 0.1,
      highlights: -0.2,
      shadows: 0.15,
      vibrance: 0.12,
      skinHueProtect: 0.8,
      clarity: 0.08,
      grain: { amount: 0.06, size: 1 },
    },
    face: { smooth: 0.28, shine: 0.25, tone: 0.15, undereye: 0.2 },
  },
  {
    key: 'clear',
    params: {
      exposure: 0.16,
      contrast: 0.2,
      highlights: -0.24,
      shadows: 0.2,
      blacks: -0.06,
      vibrance: 0.26,
      skinHueProtect: 0.85,
      clarity: 0.16,
      sharpen: 0.2,
      grain: { amount: 0.03, size: 1 },
    },
    face: {
      smooth: 0.34,
      blemish: 0.15,
      shine: 0.35,
      tone: 0.2,
      undereye: 0.28,
      eyes: 0.2,
      teeth: 0.2,
    },
  },
  {
    key: 'soft',
    params: {
      exposure: 0.1,
      contrast: -0.08,
      highlights: -0.34,
      shadows: 0.24,
      vibrance: 0.08,
      saturation: -0.06,
      skinHueProtect: 0.9,
      clarity: -0.08,
      grain: { amount: 0.12, size: 1.6 },
    },
    face: { smooth: 0.5, blemish: 0.22, shine: 0.3, tone: 0.3, undereye: 0.3 },
  },
  {
    key: 'backlit',
    params: {
      exposure: 0.3,
      contrast: 0.04,
      highlights: -0.42,
      shadows: 0.5,
      blacks: -0.02,
      vibrance: 0.18,
      skinHueProtect: 0.85,
      clarity: 0.06,
      grain: { amount: 0.07, size: 1 },
    },
    face: { smooth: 0.22, shine: 0.15, tone: 0.12, undereye: 0.35 },
  },
  {
    key: 'warm',
    params: {
      exposure: 0.08,
      contrast: 0.08,
      highlights: -0.22,
      shadows: 0.18,
      temperature: 0.18,
      tint: 0.04,
      vibrance: 0.16,
      skinHueProtect: 0.8,
      clarity: 0.06,
      grain: { amount: 0.08, size: 1.2 },
    },
    face: {
      smooth: 0.3,
      shine: 0.25,
      tone: 0.18,
      undereye: 0.22,
      cheek: { amount: 0.18, hue: 18 },
    },
  },
  {
    key: 'cool',
    params: {
      exposure: 0.06,
      contrast: 0.12,
      highlights: -0.2,
      shadows: 0.16,
      temperature: -0.16,
      tint: -0.03,
      vibrance: 0.1,
      skinHueProtect: 0.75,
      clarity: 0.1,
      split: {
        shadowHue: 232,
        shadowAmount: 0.22,
        highlightHue: 44,
        highlightAmount: 0.08,
        balance: 0,
      },
      grain: { amount: 0.05, size: 1 },
    },
    face: { smooth: 0.3, shine: 0.3, tone: 0.2, undereye: 0.2 },
  },
  {
    key: 'vivid',
    params: {
      exposure: 0.08,
      contrast: 0.28,
      highlights: -0.26,
      shadows: 0.12,
      blacks: -0.1,
      vibrance: 0.34,
      saturation: 0.16,
      skinHueProtect: 0.7,
      clarity: 0.24,
      sharpen: 0.3,
      grain: { amount: 0.02, size: 1 },
    },
    face: {
      smooth: 0.2,
      shine: 0.3,
      eyes: 0.25,
      teeth: 0.25,
      lip: { amount: 0.2, hue: 6 },
      cheek: { amount: 0.2, hue: 14 },
    },
  },
  {
    key: 'film',
    params: {
      exposure: 0.06,
      contrast: 0.14,
      highlights: -0.3,
      shadows: 0.22,
      vibrance: 0.06,
      saturation: -0.12,
      skinHueProtect: 0.85,
      clarity: 0.04,
      fade: 0.3,
      split: {
        shadowHue: 206,
        shadowAmount: 0.26,
        highlightHue: 52,
        highlightAmount: 0.3,
        balance: 0.1,
      },
      grain: { amount: 0.3, size: 1.4 },
    },
    face: { smooth: 0.16, texture: 0.1, shine: 0.12 },
  },
  {
    key: 'retro',
    params: {
      exposure: 0.04,
      contrast: -0.06,
      highlights: -0.24,
      shadows: 0.26,
      temperature: 0.12,
      saturation: -0.18,
      skinHueProtect: 0.8,
      fade: 0.46,
      split: {
        shadowHue: 32,
        shadowAmount: 0.2,
        highlightHue: 66,
        highlightAmount: 0.36,
        balance: -0.1,
      },
      vignette: { amount: 0.3, midpoint: 0.5, feather: 0.7, roundness: 0.4 },
      grain: { amount: 0.34, size: 1.8 },
    },
    face: { smooth: 0.14, shine: 0.1 },
  },
  {
    key: 'dreamy',
    params: {
      exposure: 0.14,
      contrast: -0.12,
      highlights: -0.36,
      shadows: 0.3,
      vibrance: 0.1,
      saturation: -0.04,
      skinHueProtect: 0.9,
      clarity: -0.16,
      glow: { amount: 0.42, threshold: 0.52 },
      fade: 0.18,
      grain: { amount: 0.1, size: 1.5 },
    },
    face: { smooth: 0.55, blemish: 0.3, texture: -0.15, shine: 0.35, tone: 0.35 },
  },
  {
    key: 'mono',
    params: {
      exposure: 0.06,
      contrast: 0.26,
      highlights: -0.28,
      shadows: 0.2,
      blacks: -0.08,
      clarity: 0.18,
      sharpen: 0.2,
      mono: { amount: 1, red: 0.26, green: 0.62, blue: 0.12 },
      grain: { amount: 0.26, size: 1.3 },
    },
    face: { smooth: 0.24, shine: 0.2, undereye: 0.2 },
  },
  { key: 'none', params: {} },
];

/**
 * Parameters the strength dial leaves alone.
 *
 * How bright a photo is, and how its colour was lit, are facts about the photo.
 * How much of a finish to apply is a separate choice. Scaling both together
 * means turning the finish down also undoes the exposure correction, which is
 * not what anyone is asking for when they move that slider.
 */
const EXEMPT = new Set<keyof GlobalParams>([
  'exposure',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temperature',
  'tint',
  'skinHueProtect',
  'curve',
]);

/**
 * Which fields inside a grouped parameter are amounts.
 *
 * The rest of a group describes what the effect is rather than how much of it
 * there is — a hue, a threshold, a grain size — and scaling those would make
 * turning a finish down also change its colour.
 */
const AMOUNTS: Record<string, readonly string[]> = {
  grain: ['amount'],
  mono: ['amount'],
  glow: ['amount'],
  vignette: ['amount'],
  split: ['shadowAmount', 'highlightAmount'],
};

function scaleGroup(key: string, value: object, factor: number): object {
  if (key === 'hsl') {
    // Every field of a hue band is an amount, including the rotation.
    const out: Record<string, unknown> = {};
    for (const [band, adjust] of Object.entries(value)) {
      const entries = Object.entries(adjust as Record<string, number>);
      out[band] = Object.fromEntries(
        entries.map(([field, amount]) => [field, clampUnit(amount * factor)]),
      );
    }
    return out;
  }
  const amounts = AMOUNTS[key];
  if (!amounts) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of amounts) {
    const amount = out[field];
    if (typeof amount === 'number') out[field] = Math.max(0, Math.min(1, amount * factor));
  }
  return out;
}

function clampUnit(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  // Scaling a negative amount to nothing leaves a negative zero, which renders
  // identically and reads as a value in a shared recipe. Zero is what it is.
  return clamped === 0 ? 0 : clamped;
}

/** Scale a finish around the strength it was written at. */
export function applyStrength(
  base: Partial<GlobalParams>,
  strength: number,
): Partial<GlobalParams> {
  const factor = Math.max(0, strength) / REFERENCE_STRENGTH;
  const out: Partial<GlobalParams> = {};
  for (const [key, value] of Object.entries(base) as [keyof GlobalParams, unknown][]) {
    if (EXEMPT.has(key)) {
      Object.assign(out, { [key]: value });
      continue;
    }
    if (typeof value === 'number') {
      Object.assign(out, { [key]: clampUnit(value * factor) });
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, { [key]: scaleGroup(key, value, factor) });
    }
  }
  return out;
}

/**
 * Parameters the strength dial leaves alone in the face block.
 *
 * Only the radius. How wide the filter is describes what the smoothing is, the
 * way a grain size or a split-toning hue does; everything else in the block is
 * an amount, including the texture trim — turning a finish down has to take
 * back what it did to the skin's texture as well as how much it smoothed.
 */
const FACE_EXEMPT = new Set<string>(['radius']);

/**
 * Whether one face parameter is left alone by the strength dial.
 *
 * Exported so the editor can keep the dial meaningful after a manual edit
 * without keeping its own copy of this list. Two copies of a rule like this
 * drift, and the drift shows up as a slider that jumps when the dial is next
 * touched.
 */
export function isFaceStrengthExempt(key: string): boolean {
  return FACE_EXEMPT.has(key);
}

/** And which fields of the grouped face parameters are amounts. */
const FACE_AMOUNTS: Record<string, readonly string[]> = {
  lip: ['amount'],
  cheek: ['amount'],
};

/** Scale a finish's face block around the strength it was written at. */
export function applyFaceStrength(
  base: Partial<FaceParams>,
  strength: number,
): Partial<FaceParams> {
  const factor = Math.max(0, strength) / REFERENCE_STRENGTH;
  const out: Partial<FaceParams> = {};
  for (const [key, value] of Object.entries(base) as [keyof FaceParams, unknown][]) {
    if (isFaceStrengthExempt(key)) {
      Object.assign(out, { [key]: value });
      continue;
    }
    if (typeof value === 'number') {
      Object.assign(out, { [key]: clampUnit(value * factor) });
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const amounts = FACE_AMOUNTS[key] ?? [];
      const group: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const field of amounts) {
        const amount = group[field];
        if (typeof amount === 'number') {
          group[field] = Math.max(0, Math.min(1, amount * factor));
        }
      }
      Object.assign(out, { [key]: group });
    }
  }
  return out;
}

export function lookByKey(key: string): Look | undefined {
  return LOOKS.find((look) => look.key === key);
}
