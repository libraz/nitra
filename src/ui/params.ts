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
  special?: 'curve' | 'bands';
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
      spec('face.teeth', 'params.faceTeeth'),
      spec('face.lip.amount', 'params.faceLipAmount'),
      spec('face.lip.hue', 'params.faceLipHue'),
      spec('face.cheek.amount', 'params.faceCheekAmount'),
      spec('face.cheek.hue', 'params.faceCheekHue'),
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
