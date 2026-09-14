/**
 * The edit recipe: the entire description of an edit, with no pixels in it.
 *
 * Two rules govern every field here, and neither can be relaxed later without
 * breaking recipes other people already hold:
 *
 * - Every amount is relative. Radii are fractions of image size, coordinates are
 *   normalised. A recipe carrying absolute pixels means something different the
 *   moment it is applied to a second photo.
 * - Every default means "no effect". A field that is absent — because it was
 *   written by an older build, or dropped by a newer one — has to degrade to
 *   leaving the image alone.
 *
 * The schema describes what this build renders and nothing else. A stage that
 * does not exist yet does not get a placeholder field: because an absent field
 * always means "no effect", adding one when the stage lands is a backward
 * compatible change, while shipping a field the renderer ignores is a parameter
 * that silently does nothing.
 */

import { z } from 'zod';

/** The range and neutral value of one numeric parameter. */
export interface ParamDef {
  /**
   * Dotted path from the recipe root, e.g. `global.exposure`.
   *
   * Text-layer fields are the exception: they are registered once as `text.size`
   * rather than per layer, because layers are addressed by index and a range
   * belongs to the field, not to the third one of them.
   */
  path: string;
  min: number;
  max: number;
  /** The value that means "no effect". */
  neutral: number;
}

const registry = new Map<string, ParamDef>();

/**
 * Declare a numeric parameter.
 *
 * The range lives here and nowhere else: slider bounds, shader clamps and
 * boundary validation all read it back out of {@link paramDefs}.
 */
function num(path: string, min: number, max: number, neutral: number) {
  registry.set(path, { path, min, max, neutral });
  return z.number().min(min).max(max).default(neutral);
}

/** Every declared numeric parameter, keyed by dotted path. */
export function paramDefs(): ReadonlyMap<string, ParamDef> {
  return registry;
}

export function paramDef(path: string): ParamDef {
  const def = registry.get(path);
  if (!def) throw new Error(`unknown parameter: ${path}`);
  return def;
}

export const CURRENT_RECIPE_VERSION = 1;

const colorSpace = z.enum(['srgb', 'display-p3']);

const curvePoint = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);

/**
 * The hue bands the per-colour adjustments are split into.
 *
 * Names are the colours a photographer would ask for; the hue angles they sit at
 * are a rendering detail and live with the shader that weights them.
 */
export const HUE_BANDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'magenta',
] as const;

export type HueBand = (typeof HUE_BANDS)[number];

function hueBand(band: HueBand) {
  return z
    .object({
      /** Rotates the band's hue, in a fraction of the distance to its neighbour. */
      hue: num(`global.hsl.${band}.hue`, -1, 1, 0),
      saturation: num(`global.hsl.${band}.saturation`, -1, 1, 0),
      luminance: num(`global.hsl.${band}.luminance`, -1, 1, 0),
    })
    .prefault({});
}

const hslSchema = z
  .object({
    red: hueBand('red'),
    orange: hueBand('orange'),
    yellow: hueBand('yellow'),
    green: hueBand('green'),
    cyan: hueBand('cyan'),
    blue: hueBand('blue'),
    purple: hueBand('purple'),
    magenta: hueBand('magenta'),
  })
  .prefault({});

/** Global grade. Applies to the whole image and needs no face to be present. */
const globalSchema = z.object({
  exposure: num('global.exposure', -1, 1, 0),
  contrast: num('global.contrast', -1, 1, 0),
  highlights: num('global.highlights', -1, 1, 0),
  shadows: num('global.shadows', -1, 1, 0),
  whites: num('global.whites', -1, 1, 0),
  blacks: num('global.blacks', -1, 1, 0),
  temperature: num('global.temperature', -1, 1, 0),
  tint: num('global.tint', -1, 1, 0),
  vibrance: num('global.vibrance', -1, 1, 0),
  saturation: num('global.saturation', -1, 1, 0),
  /** Attenuates saturation gain inside the skin hue band. */
  skinHueProtect: num('global.skinHueProtect', 0, 1, 0),
  clarity: num('global.clarity', -1, 1, 0),
  /** Per-hue-band hue rotation, saturation and lightness. */
  hsl: hslSchema,
  /**
   * Tints the ends of the tonal range against each other.
   *
   * Hues are absolute degrees because a tint is chosen by the colour it is, not
   * as an offset from something; the amounts around them are relative as usual.
   */
  split: z
    .object({
      shadowHue: num('global.split.shadowHue', 0, 360, 220),
      shadowAmount: num('global.split.shadowAmount', 0, 1, 0),
      highlightHue: num('global.split.highlightHue', 0, 360, 48),
      highlightAmount: num('global.split.highlightAmount', 0, 1, 0),
      /** Moves the division between the two, towards shadows at -1. */
      balance: num('global.split.balance', -1, 1, 0),
    })
    .prefault({}),
  /** Monochrome conversion with per-channel weights. */
  mono: z
    .object({
      amount: num('global.mono.amount', 0, 1, 0),
      red: num('global.mono.red', -1, 2, 0.2126),
      green: num('global.mono.green', -1, 2, 0.7152),
      blue: num('global.mono.blue', -1, 2, 0.0722),
    })
    .prefault({}),
  /** Lifts the black point without moving the rest, for a matte finish. */
  fade: num('global.fade', 0, 1, 0),
  /** Darkens or lightens towards the corners. Radii are fractions of the frame. */
  vignette: z
    .object({
      amount: num('global.vignette.amount', -1, 1, 0),
      /** Where the falloff starts, as a fraction of the half-diagonal. */
      midpoint: num('global.vignette.midpoint', 0.1, 1, 0.55),
      feather: num('global.vignette.feather', 0.05, 1, 0.6),
      /** 0 follows the frame, 1 is a circle. */
      roundness: num('global.vignette.roundness', 0, 1, 0.5),
    })
    .prefault({}),
  /** Blooms the highlights into their surroundings. */
  glow: z
    .object({
      amount: num('global.glow.amount', 0, 1, 0),
      /** Display-referred level the bloom starts above. */
      threshold: num('global.glow.threshold', 0, 1, 0.6),
    })
    .prefault({}),
  /** Output-referred unsharp mask, applied at the exported resolution. */
  sharpen: num('global.sharpen', 0, 1, 0),
  grain: z
    .object({
      amount: num('global.grain.amount', 0, 1, 0),
      /** Grain size relative to the image, so it survives a resolution change. */
      size: num('global.grain.size', 0.25, 4, 1),
    })
    .prefault({}),
  /** Tone curve control points, in display-referred 0..1. */
  curve: z
    .array(curvePoint)
    .min(2)
    .default([
      [0, 0],
      [1, 1],
    ]),
});

/**
 * Framing: flips, rotation, straightening and the crop rectangle.
 *
 * The crop is normalised against the frame that rotation and straightening
 * produce, not against the source, so the same recipe crops the same part of a
 * differently sized copy of the photo.
 */
const geometrySchema = z
  .object({
    /** Whole 90° turns, clockwise. */
    quarterTurns: z.number().int().min(0).max(3).default(0),
    flipH: z.boolean().default(false),
    flipV: z.boolean().default(false),
    /** Fine rotation in degrees. The frame shrinks to stay filled. */
    straighten: num('geometry.straighten', -20, 20, 0),
    crop: z
      .object({
        x: num('geometry.crop.x', 0, 1, 0),
        y: num('geometry.crop.y', 0, 1, 0),
        w: num('geometry.crop.w', 0.02, 1, 1),
        h: num('geometry.crop.h', 0.02, 1, 1),
      })
      .prefault({}),
    /**
     * The aspect the crop is locked to.
     *
     * Held in the recipe rather than in the panel because reopening an edit and
     * finding the lock gone is how a carefully framed crop gets destroyed by the
     * next drag.
     */
    aspect: z.string().default('free'),
  })
  .prefault({});

/**
 * Splitting one picture across several posts.
 *
 * A profile grid is filled newest first, so the tiles have to be posted in
 * reverse; the export names carry that order rather than leaving it to be
 * worked out from the row and column.
 */
const tilesSchema = z
  .object({
    cols: z.number().int().min(1).max(6).default(1),
    rows: z.number().int().min(1).max(6).default(1),
    /** Gutter taken out between tiles, as a fraction of the frame's short edge. */
    gap: num('tiles.gap', 0, 0.1, 0),
  })
  .prefault({});

/** One line of text drawn over the photo. */
const textLayerSchema = z.object({
  id: z.string(),
  content: z.string().default(''),
  /** Centre of the text box, normalised against the cropped frame. */
  x: num('text.x', 0, 1, 0.5),
  y: num('text.y', 0, 1, 0.5),
  /** Type size as a fraction of the frame's short edge, so it survives a resize. */
  size: num('text.size', 0.01, 0.5, 0.08),
  /** Key into the font catalogue, not a CSS family name. */
  font: z.string().default('sans'),
  weight: z.number().int().min(100).max(900).default(600),
  /** Degrees, clockwise. */
  rotation: num('text.rotation', -180, 180, 0),
  /** sRGB hex, `#rrggbb`. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#ffffff'),
  opacity: num('text.opacity', 0, 1, 1),
  align: z.enum(['left', 'center', 'right']).default('center'),
  /** Extra spacing between glyphs, as a fraction of the size. */
  tracking: num('text.tracking', -0.1, 0.5, 0),
  lineHeight: num('text.lineHeight', 0.8, 2.5, 1.25),
  /** Outline width as a fraction of the size. */
  outline: num('text.outline', 0, 0.2, 0),
  outlineColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#000000'),
  /** Drop shadow opacity; its offset and blur scale with the size. */
  shadow: num('text.shadow', 0, 1, 0),
  /** Filled plate behind the text, for legibility over a busy photo. */
  background: num('text.background', 0, 1, 0),
  backgroundColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#000000'),
});

/**
 * What the exported file says about itself.
 *
 * Removal is the default and stays the default: `strip` is what an absent field
 * means, so a recipe from any build that does not know about this block exports
 * a file with nothing identifying in it.
 *
 * Two things follow from writing metadata rather than only removing it. The
 * values live in the recipe, so a recipe shared in `custom` mode carries the
 * coordinates typed into it — which is why the panel says so. And only the
 * fields declared here are ever written: there is no pass-through of the source
 * file's block, so what lands in the export is the list the panel showed.
 */
const metadataSchema = z
  .object({
    /**
     * `strip` writes nothing, `keep` writes back what the photo arrived
     * carrying, `custom` writes the blocks below that are switched on.
     */
    mode: z.enum(['strip', 'keep', 'custom']).default('strip'),
    gps: z
      .object({
        write: z.boolean().default(false),
        latitude: z.number().min(-90).max(90).default(0),
        longitude: z.number().min(-180).max(180).default(0),
        /** Metres above sea level; negative is below it. */
        altitude: z.number().min(-11000).max(30000).default(0),
      })
      .prefault({}),
    capture: z
      .object({
        write: z.boolean().default(false),
        /** Local date and time as `YYYY-MM-DDTHH:MM`. Empty writes no stamp. */
        taken: z.string().max(32).default(''),
        make: z.string().max(64).default(''),
        model: z.string().max(64).default(''),
        lens: z.string().max(96).default(''),
        iso: z.number().int().min(0).max(4_194_304).default(0),
        fNumber: z.number().min(0).max(256).default(0),
        /** Shutter speed in seconds. */
        exposureTime: z.number().min(0).max(3600).default(0),
        /** Focal length in millimetres. */
        focalLength: z.number().min(0).max(10_000).default(0),
      })
      .prefault({}),
    credit: z
      .object({
        write: z.boolean().default(false),
        artist: z.string().max(128).default(''),
        copyright: z.string().max(128).default(''),
        description: z.string().max(512).default(''),
      })
      .prefault({}),
    /** Name nitra as the software that produced the file. Still a tag, so off. */
    software: z.boolean().default(false),
  })
  .prefault({});

const outputSchema = z.object({
  format: z.enum(['jpeg', 'png', 'webp']).default('jpeg'),
  quality: z.number().min(0.1).max(1).default(0.92),
  space: colorSpace.default('display-p3'),
  /**
   * Long edge of each exported file, in pixels. Zero keeps the source size.
   *
   * It is per file rather than per edit, so a tiled export gives every tile the
   * size the destination wants instead of the whole assembled picture.
   */
  longEdge: z.number().int().min(0).max(8192).default(0),
  metadata: metadataSchema,
});

export const recipeSchema = z.object({
  version: z.number().int().default(CURRENT_RECIPE_VERSION),
  /** What the recipe was authored against. Advisory: amounts stay relative. */
  source: z
    .object({
      w: z.number().int().positive(),
      h: z.number().int().positive(),
      space: colorSpace,
    })
    .optional(),
  geometry: geometrySchema,
  global: globalSchema.prefault({}),
  text: z.array(textLayerSchema).default([]),
  tiles: tilesSchema,
  output: outputSchema.prefault({}),
});

export type Recipe = z.infer<typeof recipeSchema>;
export type GlobalParams = Recipe['global'];
export type GeometryParams = Recipe['geometry'];
export type TileParams = Recipe['tiles'];
export type TextLayer = Recipe['text'][number];
export type OutputParams = Recipe['output'];
export type MetadataParams = Recipe['output']['metadata'];

/** A recipe with every parameter at its no-effect value. */
export function neutralRecipe(): Recipe {
  return recipeSchema.parse({ version: CURRENT_RECIPE_VERSION });
}

/** A text layer with every field at its default, ready to be given content. */
export function neutralTextLayer(id: string): TextLayer {
  return textLayerSchema.parse({ id });
}

/** True when the curve is the identity and the shader can skip the lookup. */
export function isIdentityCurve(points: GlobalParams['curve']): boolean {
  return points.every(([x, y]) => Math.abs(x - y) < 1e-6);
}
