/**
 * Recipe amounts resolved into shader uniforms and working sizes.
 *
 * This is where a fraction of a face becomes a number of texels. It is
 * arithmetic over the recipe and the pass context and nothing else: there is no
 * GL call in here, which is what makes every one of these testable without a
 * device and readable without one either.
 */

import type { FaceMaskRegion } from '../face/raster';
import { type ControlPoint, MAX_CONTROL_POINTS } from '../face/warp';
import { type FaceParams, HUE_BANDS, isWarpNeutral, type Recipe } from '../recipe/schema';
import type { PassContext } from './context';

/** Width the low-frequency reference is built at, whatever the image size. */
export const LOW_FREQUENCY_WIDTH = 256;

/**
 * Longest edge the guided filter behind the skin stage is computed at.
 *
 * Over the working area around the faces, not over the frame, and read out of
 * the source rather than out of the framed render. Both of those matter.
 *
 * Over the faces, because the filter has to resolve them: spread across a large
 * photograph at any affordable size, a face that is a twentieth of the frame
 * gets a couple of dozen texels, and coefficients that coarse magnified back up
 * are the blotches they were supposed to remove.
 *
 * Out of the source, because that is what makes the result independent of the
 * render scale. Reading the framed image instead would compute the filter from
 * a 1024-pixel proxy while previewing and from twelve megapixels while
 * exporting, and a preview that smooths differently from the file is a preview
 * that lies.
 */
export const FACE_FILTER_EDGE = 512;

/**
 * The widest box any blur here may use, in texels.
 *
 * The shader's loop is bounded by a constant so it compiles everywhere, and
 * this is that constant. A radius is clamped to it rather than silently
 * truncated: the alternative is a filter that quietly stops widening on a photo
 * whose face is large in the frame.
 */
export const MAX_BLUR_RADIUS = 64;

export function fitLongEdge(width: number, height: number, longEdge: number): [number, number] {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export function fitWidth(width: number, height: number, target: number): [number, number] {
  const scale = Math.min(1, target / width);
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/**
 * Everything the grade shader reads, in one object.
 *
 * The cache key is this object serialised, so a parameter cannot be added to the
 * shader and forgotten in the signature — the failure that would cause is a
 * slider that moves and changes nothing until something else invalidates the
 * cache, which looks like a broken control rather than a stale one.
 */
export interface GradeUniforms {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  vibrance: number;
  saturation: number;
  skinProtect: number;
  hsl: number[];
  useHsl: boolean;
  monoAmount: number;
  monoWeights: [number, number, number];
  splitShadowHue: number;
  splitShadowAmount: number;
  splitHighlightHue: number;
  splitHighlightAmount: number;
  splitBalance: number;
  fade: number;
  vignette: number;
  vignetteMid: number;
  vignetteFeather: number;
  vignetteRound: number;
  aspect: number;
  curveKey: string;
}

export function gradeUniforms(recipe: Recipe, aspect: number, curveKey: string): GradeUniforms {
  const g = recipe.global;
  const hsl: number[] = [];
  let useHsl = false;
  for (const band of HUE_BANDS) {
    const b = g.hsl[band];
    hsl.push(b.hue, b.saturation, b.luminance);
    if (Math.abs(b.hue) > 1e-4 || Math.abs(b.saturation) > 1e-4 || Math.abs(b.luminance) > 1e-4) {
      useHsl = true;
    }
  }
  return {
    exposure: g.exposure,
    contrast: g.contrast,
    highlights: g.highlights,
    shadows: g.shadows,
    whites: g.whites,
    blacks: g.blacks,
    temperature: g.temperature,
    tint: g.tint,
    vibrance: g.vibrance,
    saturation: g.saturation,
    skinProtect: g.skinHueProtect,
    hsl,
    useHsl,
    monoAmount: g.mono.amount,
    monoWeights: [g.mono.red, g.mono.green, g.mono.blue],
    splitShadowHue: g.split.shadowHue,
    splitShadowAmount: g.split.shadowAmount,
    splitHighlightHue: g.split.highlightHue,
    splitHighlightAmount: g.split.highlightAmount,
    splitBalance: g.split.balance,
    fade: g.fade,
    vignette: g.vignette.amount,
    vignetteMid: g.vignette.midpoint,
    vignetteFeather: g.vignette.feather,
    vignetteRound: g.vignette.roundness,
    aspect,
    curveKey,
  };
}

/**
 * The working area as the shaders take it.
 *
 * A rectangle in normalised image coordinates. Without a face there is no
 * working area, and the whole frame stands in — the stages are switched off in
 * that case, so what it maps to does not matter, only that it is well formed.
 */
export function rectOf(region: FaceMaskRegion): [number, number, number, number] {
  return [region.x, region.y, region.width, region.height];
}

export function regionOf(ctx: PassContext): [number, number, number, number] {
  return rectOf(ctx.face?.region ?? { x: 0, y: 0, width: 1, height: 1 });
}

/** Size the guided filter behind the skin stage is evaluated at. */
export function faceFilterSize(ctx: PassContext): [number, number] {
  if (!ctx.face) return [1, 1];
  const [width, height] = ctx.face.regionPixels;
  return fitLongEdge(width, height, FACE_FILTER_EDGE);
}

/**
 * Whether anything is being reshaped.
 *
 * Asked by the field, by the resampling and by every stage that reads a mask,
 * so all of them agree — a stage that thought the face had moved while the
 * resampling thought it had not would read its mask a displacement away from
 * where the pixels are.
 */
export function isWarping(recipe: Recipe, ctx: PassContext): boolean {
  return ctx.face !== null && ctx.face.faces.length > 0 && !isWarpNeutral(recipe.face);
}

/**
 * The control points, as the two uniform arrays the field shader declares.
 *
 * Sent full length and zero filled rather than trimmed to the count. The
 * shader stops at `uCount`, so the tail is never read, and a short write is the
 * kind of thing a driver is entitled to treat differently from a long one.
 */
export function packControlPoints(points: readonly ControlPoint[]): {
  point: Float32Array;
  delta: Float32Array;
} {
  const point = new Float32Array(MAX_CONTROL_POINTS * 4);
  const delta = new Float32Array(MAX_CONTROL_POINTS * 4);
  points.forEach((p, i) => {
    point[i * 4] = p.centre.x;
    point[i * 4 + 1] = p.centre.y;
    point[i * 4 + 2] = p.radius;
    delta[i * 4] = p.delta.x;
    delta[i * 4 + 1] = p.delta.y;
  });
  return { point, delta };
}

/**
 * The filter radius, in texels of the working area.
 *
 * Two conversions, and each one is there for a reason: the recipe holds a
 * fraction of the face, and the face is a fraction of the working area. What
 * comes out is a radius that means the same retouch on the next photograph,
 * at the next resolution, with the face at the next size — which is the whole
 * point of holding the parameter as a fraction in the first place.
 */
export function skinRadius(face: FaceParams, ctx: PassContext): number {
  if (!ctx.face) return 1;
  const [width] = faceFilterSize(ctx);
  const inRegion = ctx.face.faceWidth / Math.max(ctx.face.region.width, 1e-4);
  return clampRadius(face.radius * inRegion * width, 1);
}

export function clampRadius(value: number, least: number): number {
  return Math.max(least, Math.min(MAX_BLUR_RADIUS, Math.round(value)));
}

/**
 * Everything the skin shader reads, in one object.
 *
 * Same contract as the grade uniforms: the cache key is this serialised, so a
 * parameter cannot reach the shader without reaching the signature. The failure
 * that would cause is a slider that moves and changes nothing until something
 * unrelated invalidates the cache, which reads as a broken control rather than
 * a stale one.
 */
export interface SkinUniforms {
  smooth: number;
  blemish: number;
  texture: number;
  shine: number;
  tone: number;
  radius: number;
  size: [number, number];
  face: string;
  geometry: string;
}

export function skinUniforms(recipe: Recipe, ctx: PassContext): SkinUniforms {
  const f = recipe.face;
  return {
    smooth: f.smooth,
    blemish: f.blemish,
    texture: f.texture,
    shine: f.shine,
    tone: f.tone,
    radius: skinRadius(f, ctx),
    size: faceFilterSize(ctx),
    face: ctx.face?.key ?? 'none',
    geometry: ctx.geometryKey,
  };
}

/** Everything the parts shader reads, on the same contract. */
export interface PartsUniforms {
  undereye: number;
  eyes: number;
  teeth: number;
  lip: number;
  lipHue: number;
  cheek: number;
  cheekHue: number;
  face: string;
  geometry: string;
}

export function partsUniforms(recipe: Recipe, ctx: PassContext): PartsUniforms {
  const f = recipe.face;
  return {
    undereye: f.undereye,
    eyes: f.eyes,
    teeth: f.teeth,
    lip: f.lip.amount,
    lipHue: f.lip.hue,
    cheek: f.cheek.amount,
    cheekHue: f.cheek.hue,
    face: ctx.face?.key ?? 'none',
    geometry: ctx.geometryKey,
  };
}

export function lowSize(ctx: PassContext): [number, number] {
  return fitWidth(ctx.width, ctx.height, LOW_FREQUENCY_WIDTH);
}
