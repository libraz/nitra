/**
 * Finishes, and the dial that scales them.
 *
 * A finish is picked by looking at the user's own photo rendered through it, not
 * by reading its name, so what is defined here is only the numbers. The caption
 * under each thumbnail is looked up from the message catalogue by `key`.
 */

import type { GlobalParams } from './schema';

export interface Look {
  key: string;
  params: Partial<GlobalParams>;
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
  return Math.max(-1, Math.min(1, value));
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

export function lookByKey(key: string): Look | undefined {
  return LOOKS.find((look) => look.key === key);
}
