/**
 * The parameters the detail panel exposes.
 *
 * Grouping and message keys live here; ranges do not. Those are read back out of
 * the recipe schema, so a slider cannot offer a value the shader would have to
 * clamp, and widening a range is a single edit in the schema.
 */

import { HUE_BANDS, paramDef, type Recipe } from '../core/recipe/schema';
import type { MessageKey } from '../i18n';

export interface ParamSpec {
  /** Dotted path into the recipe. */
  path: string;
  labelKey: MessageKey;
  min: number;
  max: number;
  neutral: number;
  /** True when the parameter runs either side of neutral. */
  bipolar: boolean;
}

export interface ParamGroup {
  id: string;
  nameKey: MessageKey;
  params: ParamSpec[];
  /** Extra control drawn above the group's sliders. */
  special?: 'curve' | 'bands' | 'aperture' | 'light';
  defaultOpen?: boolean;
  /**
   * True when the group does nothing without a face in the photo.
   *
   * The panel says so rather than leaving the sliders live and inert. A control
   * that moves and changes nothing reads as a broken control, and the reason it
   * is not moving anything is something the app knows and can simply state.
   */
  requiresFace?: boolean;
}

/**
 * How finely a slider can be dragged, and how many decimals its readout needs.
 *
 * Both follow from the range rather than being fixed. A hundredth is the right
 * step for an amount running from zero to one, and useless for a radius running
 * from two thousandths to three hundredths: it would offer three positions on
 * the whole track and round the default away from itself, which reads as a
 * control that refuses to sit where it started.
 *
 * A hundred steps is what the amounts already had, so this changes nothing for
 * them and only sharpens the narrow ranges — the fractions of an image, where
 * the interesting part of the range is a long way inside a hundredth.
 */
export function granularity(span: number): { step: number; decimals: number } {
  const step = 10 ** Math.floor(Math.log10(span / 100));
  return { step, decimals: Math.max(0, Math.min(6, -Math.floor(Math.log10(step)))) };
}

export function spec(path: string, labelKey: MessageKey): ParamSpec {
  const def = paramDef(path);
  return {
    path,
    labelKey,
    min: def.min,
    max: def.max,
    neutral: def.neutral,
    bipolar: def.min < def.neutral,
  };
}

export const GROUPS: readonly ParamGroup[] = [
  // The order the panel reads in is the order the picture is built in, which is
  // the only ordering that keeps explaining itself as stages are added.
  // Reshaping moves the pixels the skin stage then works on, so it comes first
  // here for the same reason it comes first there.
  {
    id: 'reshape',
    nameKey: 'groups.reshape',
    requiresFace: true,
    params: [
      spec('face.warp.faceSlim', 'params.faceSlim'),
      spec('face.warp.jawline', 'params.faceJawline'),
      spec('face.warp.chin', 'params.faceChin'),
      spec('face.warp.eyeEnlarge', 'params.faceEyeEnlarge'),
      spec('face.warp.eyeTilt', 'params.faceEyeTilt'),
      spec('face.warp.noseNarrow', 'params.faceNoseNarrow'),
      spec('face.warp.noseBridge', 'params.faceNoseBridge'),
      spec('face.warp.mouthWidth', 'params.faceMouthWidth'),
    ],
  },
  {
    id: 'skin',
    nameKey: 'groups.skin',
    requiresFace: true,
    defaultOpen: true,
    params: [
      spec('face.smooth', 'params.faceSmooth'),
      spec('face.blemish', 'params.faceBlemish'),
      spec('face.texture', 'params.faceTexture'),
      spec('face.radius', 'params.faceRadius'),
      spec('face.tone', 'params.faceTone'),
      spec('face.shine', 'params.faceShine'),
    ],
  },
  {
    id: 'parts',
    nameKey: 'groups.parts',
    requiresFace: true,
    params: [
      spec('face.undereye', 'params.faceUndereye'),
      spec('face.eyes', 'params.faceEyes'),
      spec('face.iris', 'params.faceIris'),
      spec('face.catchlight', 'params.faceCatchlight'),
      spec('face.teeth', 'params.faceTeeth'),
      spec('face.lip.amount', 'params.faceLipAmount'),
      spec('face.lip.hue', 'params.faceLipHue'),
      spec('face.cheek.amount', 'params.faceCheekAmount'),
      spec('face.cheek.hue', 'params.faceCheekHue'),
    ],
  },
  // Hair is not part of the face group because it is not keyed to the
  // landmarks: what finds it is the segmentation, the same thing that finds the
  // person for the background. So it works on a head turned away, and the group
  // says nothing about needing a face.
  {
    id: 'hair',
    nameKey: 'groups.hair',
    params: [
      spec('hair.sheen', 'params.hairSheen'),
      spec('hair.grey', 'params.hairGrey'),
      spec('hair.tint.amount', 'params.hairTintAmount'),
      spec('hair.tint.hue', 'params.hairTintHue'),
    ],
  },
  // After the face and before the grade, which is where the stage runs: a lens
  // is in front of the film.
  {
    id: 'depth',
    nameKey: 'groups.depth',
    special: 'aperture',
    params: [
      spec('depth.bokeh', 'params.depthBokeh'),
      spec('depth.bokehBloom', 'params.depthBokehBloom'),
      spec('depth.catsEye', 'params.depthCatsEye'),
      spec('depth.edgeRefine', 'params.depthEdgeRefine'),
      spec('depth.bgBrightness', 'params.depthBgBrightness'),
      spec('depth.bgSaturation', 'params.depthBgSaturation'),
    ],
  },
  // After the defocus and before the tone, which is where the stage runs: a
  // light is something that was in the room, and grading is what happens to the
  // picture of it afterwards.
  {
    id: 'light',
    nameKey: 'groups.light',
    special: 'light',
    requiresFace: true,
    params: [
      spec('relight.intensity', 'params.relightIntensity'),
      spec('relight.softness', 'params.relightSoftness'),
      spec('relight.warmth', 'params.relightWarmth'),
    ],
  },
  {
    id: 'tone',
    nameKey: 'groups.tone',
    special: 'curve',
    defaultOpen: true,
    params: [
      spec('global.exposure', 'params.exposure'),
      spec('global.contrast', 'params.contrast'),
      spec('global.highlights', 'params.highlights'),
      spec('global.shadows', 'params.shadows'),
      spec('global.whites', 'params.whites'),
      spec('global.blacks', 'params.blacks'),
      spec('global.fade', 'params.fade'),
    ],
  },
  {
    id: 'color',
    nameKey: 'groups.color',
    params: [
      spec('global.temperature', 'params.temperature'),
      spec('global.tint', 'params.tint'),
      spec('global.vibrance', 'params.vibrance'),
      spec('global.saturation', 'params.saturation'),
      spec('global.skinHueProtect', 'params.skinHueProtect'),
    ],
  },
  // The per-hue sliders are built against whichever band is selected, so the
  // group carries none of its own: listing all twenty-four at once would be a
  // wall nobody reads.
  { id: 'hsl', nameKey: 'groups.hsl', special: 'bands', params: [] },
  {
    id: 'split',
    nameKey: 'groups.split',
    params: [
      spec('global.split.shadowHue', 'params.splitShadowHue'),
      spec('global.split.shadowAmount', 'params.splitShadowAmount'),
      spec('global.split.highlightHue', 'params.splitHighlightHue'),
      spec('global.split.highlightAmount', 'params.splitHighlightAmount'),
      spec('global.split.balance', 'params.splitBalance'),
    ],
  },
  {
    id: 'mono',
    nameKey: 'groups.mono',
    params: [
      spec('global.mono.amount', 'params.monoAmount'),
      spec('global.mono.red', 'params.monoRed'),
      spec('global.mono.green', 'params.monoGreen'),
      spec('global.mono.blue', 'params.monoBlue'),
    ],
  },
  {
    id: 'detail',
    nameKey: 'groups.detail',
    params: [
      spec('global.clarity', 'params.clarity'),
      spec('global.sharpen', 'params.sharpen'),
      spec('global.grain.amount', 'params.grainAmount'),
      spec('global.grain.size', 'params.grainSize'),
    ],
  },
  {
    id: 'effects',
    nameKey: 'groups.effects',
    params: [
      spec('global.glow.amount', 'params.glowAmount'),
      spec('global.glow.threshold', 'params.glowThreshold'),
      spec('global.vignette.amount', 'params.vignetteAmount'),
      spec('global.vignette.midpoint', 'params.vignetteMidpoint'),
      spec('global.vignette.feather', 'params.vignetteFeather'),
      spec('global.vignette.roundness', 'params.vignetteRoundness'),
    ],
  },
];

/** The three sliders one hue band offers. */
export function bandParams(band: string): ParamSpec[] {
  return [
    spec(`global.hsl.${band}.hue`, 'params.hslHue'),
    spec(`global.hsl.${band}.saturation`, 'params.hslSaturation'),
    spec(`global.hsl.${band}.luminance`, 'params.hslLuminance'),
  ];
}

/** Read a numeric parameter out of a recipe by path. */
export function readParam(recipe: Recipe, path: string): number {
  let cursor: unknown = recipe;
  for (const key of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return 0;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'number' ? cursor : 0;
}

/** Return a copy of `recipe` with one numeric parameter replaced. */
export function writeParam(recipe: Recipe, path: string, value: number): Recipe {
  const keys = path.split('.');
  const clone = structuredClone(recipe) as unknown as Record<string, unknown>;
  let cursor = clone;
  for (const key of keys.slice(0, -1)) {
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys.at(-1) as string] = value;
  return clone as unknown as Recipe;
}

/** True when any parameter in the group has moved off its neutral value. */
export function groupTouched(recipe: Recipe, group: ParamGroup): boolean {
  if (group.special === 'bands') {
    return HUE_BANDS.some((band) =>
      bandParams(band).some((p) => Math.abs(readParam(recipe, p.path) - p.neutral) > 1e-6),
    );
  }
  return group.params.some((p) => Math.abs(readParam(recipe, p.path) - p.neutral) > 1e-6);
}
