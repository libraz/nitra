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
 * The face stages: what happens inside a skin mask, and to the parts.
 *
 * Every radius is a fraction of the width of the face it is applied to, never
 * of the image and never in pixels. A face fills a tenth of a group photo and
 * most of a portrait, and an amount keyed to the image would mean two different
 * things; keyed to the face it means the same one, which is what lets a finish
 * carry these values at all.
 *
 * Nothing here does anything without an analysis to act on. The parameters are
 * still read and still carried, so a recipe written on a photo with a face in
 * it survives being opened next to one without: the stage is skipped, not
 * approximated.
 */
const faceSchema = z
  .object({
    /**
     * How much the skin is smoothed. The master amount.
     *
     * It drives both halves of what smoothing is: fine texture comes off and
     * slow unevenness is pushed down. The two trims below move each of those on
     * its own, and with all three at zero the stage returns the photo exactly.
     */
    smooth: num('face.smooth', 0, 1, 0),
    /** Extra weight on the slow variation in tone that reads as uneven skin. */
    blemish: num('face.blemish', 0, 1, 0),
    /**
     * Trim on how much fine texture survives the smoothing.
     *
     * Zero is whatever `smooth` implies, which is what makes the default do
     * nothing. The negative side takes the pores out sooner, which is how
     * plastic skin happens; the positive side puts texture back, which is the
     * repair for having gone too far without having to undo the rest.
     */
    texture: num('face.texture', -1, 1, 0),
    /** Radius of the edge-preserving filter, as a fraction of the face width. */
    radius: num('face.radius', 0.01, 0.08, 0.03),
    /** Pulls back specular highlights on the forehead, nose and cheeks. */
    shine: num('face.shine', 0, 1, 0),
    /** Evens out the colour of the skin towards its own local average. */
    tone: num('face.tone', 0, 1, 0),
    /** Lifts the shadow under the eyes. */
    undereye: num('face.undereye', 0, 1, 0),
    /** Brightens the white of the eye without touching the iris. */
    eyes: num('face.eyes', 0, 1, 0),
    /**
     * Definition in the iris: its pattern, and the ring at its edge.
     *
     * Local contrast rather than a darkening, so a pale eye stays pale. The
     * counterpart of `texture` on the skin, and the same reasoning — what is
     * being adjusted is how much of the detail the photograph has is visible,
     * not how dark the part is.
     */
    iris: num('face.iris', 0, 1, 0),
    /**
     * Strength of the reflection in the eye.
     *
     * It lifts the catchlight the photograph already has rather than painting
     * one in. A drawn highlight has to be put somewhere, and where it belongs
     * is decided by a light nobody can see from the file — put in the wrong
     * place it reads as a glass eye.
     */
    catchlight: num('face.catchlight', 0, 1, 0),
    /** Takes the yellow out of teeth, when the mouth is open. */
    teeth: num('face.teeth', 0, 1, 0),
    /**
     * Colour on the lips.
     *
     * The hue is an absolute angle, like the split-toning hues: a colour is
     * chosen by the colour it is. The amount around it is relative as usual.
     */
    lip: z
      .object({
        amount: num('face.lip.amount', 0, 1, 0),
        hue: num('face.lip.hue', 0, 360, 10),
      })
      .prefault({}),
    /** Colour on the cheeks, over a soft-edged disc keyed to the face width. */
    cheek: z
      .object({
        amount: num('face.cheek.amount', 0, 1, 0),
        hue: num('face.cheek.hue', 0, 360, 18),
      })
      .prefault({}),
    /**
     * Reshaping: the amounts that move the face rather than recolour it.
     *
     * Each one is a slider, not a distance. What a slider at one means in the
     * picture is decided in `src/core/face/warp.ts` as a fraction of the face's
     * own width, for the same reason every radius is: a displacement in pixels
     * would be a different retouch on the next photograph.
     *
     * The ones whose two directions are both a retouch someone asks for are
     * signed; the rest only go one way. `faceSlim` narrows, it does not widen,
     * because nobody reaches for this to make a face broader.
     */
    warp: z
      .object({
        /** Draws the outline of the face inwards, away from the ears. */
        faceSlim: num('face.warp.faceSlim', 0, 1, 0),
        /** Tightens the lower half of the outline, along the jaw. */
        jawline: num('face.warp.jawline', 0, 1, 0),
        /** Shortens the chin, or lengthens it. */
        chin: num('face.warp.chin', -1, 1, 0),
        /** Opens the eyes outwards from their own centres. */
        eyeEnlarge: num('face.warp.eyeEnlarge', 0, 1, 0),
        /** Lifts the outer corner of each eye, or drops it. */
        eyeTilt: num('face.warp.eyeTilt', -1, 1, 0),
        /** Narrows the nose towards the middle of the face. */
        noseNarrow: num('face.warp.noseNarrow', 0, 1, 0),
        /** Raises the bridge of the nose, or flattens it. */
        noseBridge: num('face.warp.noseBridge', -1, 1, 0),
        /** Widens the mouth, or narrows it. */
        mouthWidth: num('face.warp.mouthWidth', -1, 1, 0),
      })
      .prefault({}),
  })
  .prefault({});

/**
 * Hair: the sheen, the grey strands, and colour.
 *
 * Outside `face` for the same reason `depth` is: what it acts on comes from the
 * segmentation rather than from the landmarks, so it is correct on a head turned
 * away from the camera, where there are no landmarks at all.
 *
 * Everything here is relative to a local average of the photograph rather than
 * to a threshold. Hair is the darkest large thing in most portraits and the
 * brightest in some, so a sheen keyed to an absolute lightness would find the
 * highlight on dark hair and the whole head on light hair.
 */
const hairSchema = z
  .object({
    /** Strengthens the band of reflected light running along the hair. */
    sheen: num('hair.sheen', 0, 1, 0),
    /**
     * Takes grey strands back towards the colour of the hair around them.
     *
     * It asks two questions of a pixel, not one: lighter than its surroundings
     * and less coloured than them. A strand that is only lighter is a highlight,
     * and taking the colour out of a highlight is how hair comes out wet.
     */
    grey: num('hair.grey', 0, 1, 0),
    /**
     * Colour on the hair.
     *
     * The hue is an absolute angle, like the lip and split-toning hues: a colour
     * is chosen by the colour it is. The amount around it is relative as usual.
     */
    tint: z
      .object({
        amount: num('hair.tint.amount', 0, 1, 0),
        hue: num('hair.tint.hue', 0, 360, 30),
      })
      .prefault({}),
  })
  .prefault({});

/**
 * The apertures the convolution kernel can take the shape of.
 *
 * A round iris, a bladed one, and the vertically squeezed pupil of an
 * anamorphic lens. The shape is what an out-of-focus highlight comes out as,
 * which is the whole reason it is offered: a hexagonal catchlight is a
 * photograph taken at f/8 on a lens with six blades, and a Gaussian is not a
 * photograph of anything.
 */
export const APERTURES = ['circle', 'hex', 'anamorphic'] as const;
export type Aperture = (typeof APERTURES)[number];

/**
 * Background separation: the defocus, and the two adjustments that ride on it.
 *
 * Outside `face` because it is not a face adjustment. What it acts on is the
 * whole frame, divided into the person and everything behind them, and it stays
 * correct on a photograph where the face was never found — a head turned away
 * is still a person to the segmentation.
 *
 * `aperture` and `edgeRefine` describe the shape of the effect rather than how
 * much of it there is, so neither one defaults to zero, and neither is
 * consulted by {@link isDepthNeutral} — the same arrangement as `face.radius`.
 */
const depthSchema = z
  .object({
    /** How far out of focus the background is taken. */
    bokeh: num('depth.bokeh', 0, 1, 0),
    aperture: z.enum(APERTURES).default('circle'),
    /**
     * How far highlights are lifted before the convolution.
     *
     * A real out-of-focus highlight is bright because the sensor saturated
     * there: the file says 1.0 and the scene was several times that. Convolving
     * the recorded value spreads a dull grey disc, and lifting what is over the
     * threshold first is the single step that makes the result read as a lens
     * rather than as a blur.
     */
    bokehBloom: num('depth.bokehBloom', 0, 1, 0),
    /** How much the discs are clipped towards the corners of the frame. */
    catsEye: num('depth.catsEye', 0, 1, 0),
    /** Lifts the person off the background without touching the person. */
    bgBrightness: num('depth.bgBrightness', -1, 1, 0),
    bgSaturation: num('depth.bgSaturation', -1, 1, 0),
    /**
     * How hard the separation is snapped onto the photo's own edges.
     *
     * The segmentation arrives 256 pixels across, and magnified to a frame its
     * boundary sits a long way from the shoulder it is meant to follow. This is
     * the radius the guided filter gets to move it, as a fraction of the frame.
     */
    edgeRefine: num('depth.edgeRefine', 0, 1, 0.5),
  })
  .prefault({});

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
  face: faceSchema,
  hair: hairSchema,
  depth: depthSchema,
  global: globalSchema.prefault({}),
  text: z.array(textLayerSchema).default([]),
  tiles: tilesSchema,
  output: outputSchema.prefault({}),
});

export type Recipe = z.infer<typeof recipeSchema>;
export type FaceParams = Recipe['face'];
export type HairParams = Recipe['hair'];
export type DepthParams = Recipe['depth'];
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

/**
 * True when nothing in the skin stage would change a pixel.
 *
 * The renderer asks this before building anything: the guided filter, the whole
 * moment chain behind it and the mask refinement hang off a stage that answers
 * true here, and none of it runs. A photo with no face in it, or a recipe that
 * only grades, therefore costs exactly what it did before these stages existed.
 *
 * `radius` is not consulted: it says how wide the filter is, not whether any of
 * it is used, so on its own it changes nothing.
 */
export function isSkinNeutral(face: FaceParams): boolean {
  return (
    face.smooth < 1e-4 &&
    face.blemish < 1e-4 &&
    Math.abs(face.texture) < 1e-4 &&
    face.shine < 1e-4 &&
    face.tone < 1e-4
  );
}

/** True when none of the per-part adjustments would change a pixel. */
export function isPartsNeutral(face: FaceParams): boolean {
  return (
    face.undereye < 1e-4 &&
    face.eyes < 1e-4 &&
    face.iris < 1e-4 &&
    face.catchlight < 1e-4 &&
    face.teeth < 1e-4 &&
    face.lip.amount < 1e-4 &&
    face.cheek.amount < 1e-4
  );
}

/**
 * True when no reshaping amount would move a pixel.
 *
 * The renderer asks this before it builds the displacement field, and the field
 * is what every other stage's mask lookup has to go through once it exists. A
 * false answer here therefore costs more than one pass: it is the difference
 * between the face stages sampling their masks directly and sampling them
 * through a texture. A recipe that only smooths must answer true.
 */
export function isWarpNeutral(face: FaceParams): boolean {
  const w = face.warp;
  return (
    w.faceSlim < 1e-4 &&
    w.jawline < 1e-4 &&
    Math.abs(w.chin) < 1e-4 &&
    w.eyeEnlarge < 1e-4 &&
    Math.abs(w.eyeTilt) < 1e-4 &&
    w.noseNarrow < 1e-4 &&
    Math.abs(w.noseBridge) < 1e-4 &&
    Math.abs(w.mouthWidth) < 1e-4
  );
}

/**
 * True when nothing in the hair stage would change a pixel.
 *
 * The renderer asks this before it refines the hair mask, which is a nine-pass
 * guided filter over the frame plus the local average the three amounts are
 * measured against. A recipe that only grades must answer true.
 */
export function isHairNeutral(hair: HairParams): boolean {
  return hair.sheen < 1e-4 && hair.grey < 1e-4 && hair.tint.amount < 1e-4;
}

/**
 * True when nothing in the background separation would change a pixel.
 *
 * The renderer asks this before it refines the separation, and the refinement
 * is a nine-pass guided filter over the whole frame — by far the most expensive
 * thing in the block, and worth nothing at all if the background is neither
 * defocused nor adjusted.
 *
 * `bokehBloom` and `catsEye` are not consulted. Both describe what the defocus
 * looks like, so with `bokeh` at zero there is nothing for either to change.
 */
export function isDepthNeutral(depth: DepthParams): boolean {
  return (
    depth.bokeh < 1e-4 && Math.abs(depth.bgBrightness) < 1e-4 && Math.abs(depth.bgSaturation) < 1e-4
  );
}

/** True when the whole face block is at its no-effect values. */
export function isFaceNeutral(face: FaceParams): boolean {
  return isSkinNeutral(face) && isPartsNeutral(face) && isWarpNeutral(face);
}

/** True when the curve is the identity and the shader can skip the lookup. */
export function isIdentityCurve(points: GlobalParams['curve']): boolean {
  return points.every(([x, y]) => Math.abs(x - y) < 1e-6);
}
