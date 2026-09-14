/**
 * The render pipeline.
 *
 * Stage order is the part of this file that is not free to change. Framing
 * before grading so the resample happens in linear light, grading before the
 * finish stage, grain after everything that smooths, the output transform last,
 * and text after that because a caption is not light that was in the room. Each
 * of those is a decision about what the result looks like, not an implementation
 * detail.
 *
 * The expensive stages live in the effect graph and are cached. The finish stage
 * runs outside it because its destination changes: the canvas when previewing, a
 * byte buffer when exporting or measuring.
 */

import type { Mat3 } from '../color/matrix';
import { planExport } from '../geometry/tiles';
import {
  croppedSize,
  frameSize,
  frameToSource,
  geometrySignature,
  outputToSource,
} from '../geometry/transform';
import { Dag, type DagNode } from '../graph/dag';
import type { SourceImage } from '../io/decode';
import { buildCurveLut } from '../recipe/curve';
import { HUE_BANDS, isIdentityCurve, type Recipe } from '../recipe/schema';
import { rasterizeText, textSignature } from '../text/raster';
import {
  createGlContext,
  createLutTexture,
  createSourceTexture,
  createTextTexture,
  type GlContext,
  GlError,
  Program,
  type RenderTarget,
} from './gl';
import {
  BLUR_FRAGMENT,
  COPY_FRAGMENT,
  FINISH_FRAGMENT,
  GRADE_FRAGMENT,
  INGEST_FRAGMENT,
} from './shaders/passes';

/** Longest edge of the interactive proxy. */
export const PROXY_LONG_EDGE = 1024;

/** Width the low-frequency reference is built at, whatever the image size. */
const LOW_FREQUENCY_WIDTH = 256;

/** Width the guardrail measurement is taken at. */
const MEASURE_WIDTH = 256;

export type RenderScale = 'proxy' | 'full';

export interface RenderOptions {
  /** Draw the photo as it arrived, bypassing every adjustment but the framing. */
  original?: boolean;
  /**
   * Show the whole straightened frame instead of the crop.
   *
   * The crop rectangle is dragged over the parts of the photo it is about to
   * discard, so they have to keep rendering while it is being placed.
   */
  fullFrame?: boolean;
}

interface SourceTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
  fromSrgb: boolean;
  /** Bumped on every new source, so cached results cannot survive a file swap. */
  generation: number;
}

/** The framing a pass is being evaluated under. */
interface FrameSpec {
  width: number;
  height: number;
  /** Output coordinate back to source coordinate. */
  matrix: Mat3;
  key: string;
}

interface PassContext {
  gl: WebGL2RenderingContext;
  glctx: GlContext;
  programs: Programs;
  source: SourceTexture;
  width: number;
  height: number;
  geometry: Mat3;
  geometryKey: string;
  curve: WebGLTexture | null;
  curveKey: string;
}

interface Programs {
  ingest: Program;
  grade: Program;
  blur: Program;
  copy: Program;
  finish: Program;
}

/** Measured after the fact rather than predicted from the slider positions. */
export interface RenderStats {
  /** Fraction of pixels with a channel at the top of the output range. */
  highlightClip: number;
  /** Fraction of pixels with a channel at the bottom of the output range. */
  shadowClip: number;
  /** Fraction of pixels where chroma was clamped by the output gamut. */
  chromaClip: number;
  /** Luminance histogram of the result, 64 buckets. */
  histogram: Uint32Array;
  meanLuma: number;
}

function fitLongEdge(width: number, height: number, longEdge: number): [number, number] {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

function fitWidth(width: number, height: number, target: number): [number, number] {
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
interface GradeUniforms {
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

function gradeUniforms(recipe: Recipe, aspect: number, curveKey: string): GradeUniforms {
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

export class Pipeline {
  private readonly glctx: GlContext & { wideGamut: boolean };
  private readonly gl: WebGL2RenderingContext;
  private readonly programs: Programs;
  private readonly dag: Dag<PassContext, RenderTarget, Recipe>;
  private source: SourceTexture | null = null;
  private generation = 0;
  private curveTexture: WebGLTexture | null = null;
  private curveKey = 'identity';
  private textTexture: WebGLTexture | null = null;
  private textKey = 'none';
  private readonly byteTargets = new Map<string, RenderTarget>();
  private ramp: WebGLTexture | null = null;

  /**
   * @param measureViewport The box the image is allowed to occupy, in CSS pixels. It has
   * to come from an element other than the canvas: the canvas is sized from the
   * answer, so asking the canvas would make its size depend on itself and leave
   * it stuck at whatever it happened to be when it first appeared.
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly measureViewport: () => { width: number; height: number },
  ) {
    this.glctx = createGlContext(canvas);
    this.gl = this.glctx.gl;
    this.programs = {
      ingest: Program.create(this.gl, INGEST_FRAGMENT),
      grade: Program.create(this.gl, GRADE_FRAGMENT),
      blur: Program.create(this.gl, BLUR_FRAGMENT),
      copy: Program.create(this.gl, COPY_FRAGMENT),
      finish: Program.create(this.gl, FINISH_FRAGMENT),
    };
    this.dag = new Dag(buildNodes(), (target) => this.glctx.pool.release(target));
  }

  /** True when the drawing buffer can actually hold Display-P3. */
  get wideGamut(): boolean {
    return this.glctx.wideGamut;
  }

  /** True once a photo has been uploaded and there is something to draw. */
  get hasSource(): boolean {
    return this.source !== null;
  }

  setSource(image: SourceImage): void {
    this.dag.invalidate();
    if (this.source) this.gl.deleteTexture(this.source.texture);
    this.generation += 1;
    this.source = {
      texture: createSourceTexture(this.gl, image.width, image.height, image.data),
      width: image.width,
      height: image.height,
      fromSrgb: image.space === 'srgb',
      generation: this.generation,
    };
  }

  /** Size of the source, before any framing. */
  sourceSize(): [number, number] {
    const source = this.requireSource();
    return [source.width, source.height];
  }

  /** Resolution the effect graph is evaluated at for a given scale. */
  resolutionFor(recipe: Recipe, scale: RenderScale): [number, number] {
    const spec = this.frameSpec(recipe, scale, false);
    return [spec.width, spec.height];
  }

  /**
   * Draw to the canvas.
   *
   * `original` bypasses the graph but keeps the colour management, so the
   * comparison is against the photo as it is, not against a differently
   * converted copy of it.
   */
  renderToCanvas(recipe: Recipe, scale: RenderScale, options: RenderOptions = {}): void {
    const original = options.original ?? false;
    const fullFrame = options.fullFrame ?? false;
    const spec = this.frameSpec(recipe, scale, fullFrame);
    const ctx = this.context(recipe, spec);
    const variant = variantKey(spec);

    const graded = original
      ? this.dag.evaluate(ctx, recipe, 'ingest', variant)
      : this.dag.evaluate(ctx, recipe, 'grade', variant);
    const low = original ? graded : this.dag.evaluate(ctx, recipe, 'low', variant);

    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const box = this.measureViewport();
    if (box.width < 1 || box.height < 1) return;
    const aspect = spec.width / spec.height;
    let cssWidth = box.width;
    let cssHeight = box.width / aspect;
    if (cssHeight > box.height) {
      cssHeight = box.height;
      cssWidth = box.height * aspect;
    }
    const bufferWidth = Math.max(1, Math.round(cssWidth * dpr));
    const bufferHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== bufferWidth || this.canvas.height !== bufferHeight) {
      this.canvas.width = bufferWidth;
      this.canvas.height = bufferHeight;
    }
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Text is placed against the crop, so it is left off while the whole frame
    // is on screen: drawing it over a picture it does not belong to would put a
    // caption somewhere it will never appear.
    const text = original || fullFrame ? null : this.syncText(recipe, bufferWidth, bufferHeight);
    this.runFinish(recipe, graded, low, text, null, bufferWidth, bufferHeight, true, original);
  }

  /**
   * Evaluate at export size and read the result back for encoding.
   *
   * This is the only path that reads pixels off the GPU at image size, and it is
   * deliberately not reachable from a slider: a synchronous read stalls the
   * pipeline, which is felt immediately as a slider that stops following.
   */
  readFullResolution(recipe: Recipe): ImageData {
    const spec = this.frameSpec(recipe, 'full', false);
    const ctx = this.context(recipe, spec);
    const variant = variantKey(spec);
    const graded = this.dag.evaluate(ctx, recipe, 'grade', variant);
    const low = this.dag.evaluate(ctx, recipe, 'low', variant);
    const text = this.syncText(recipe, spec.width, spec.height);

    const target = this.acquireByteTarget(spec.width, spec.height);
    this.runFinish(recipe, graded, low, text, target, spec.width, spec.height, false, false);
    const pixels = this.readBack(target, spec.width, spec.height);
    return new ImageData(pixels, spec.width, spec.height, { colorSpace: recipe.output.space });
  }

  /**
   * Render a small copy for the finish picker.
   *
   * The thumbnails are the user's own photo through each finish. A named swatch
   * asks someone to know what "clear" means; their own face answers it. The
   * framing is applied so the swatches show the picture being made; the text is
   * not, because a caption at two hundred pixels is a smudge.
   */
  renderThumbnail(recipe: Recipe, maxEdge: number): ImageData {
    const source = this.requireSource();
    const [cropW, cropH] = croppedSize(source.width, source.height, recipe.geometry);
    const [width, height] = fitLongEdge(cropW, cropH, maxEdge);
    const spec: FrameSpec = {
      width,
      height,
      matrix: outputToSource(source.width, source.height, recipe.geometry),
      key: geometrySignature(recipe.geometry),
    };
    const ctx = this.context(recipe, spec);
    const variant = variantKey(spec);
    const graded = this.dag.evaluate(ctx, recipe, 'grade', variant);
    const low = this.dag.evaluate(ctx, recipe, 'low', variant);

    const target = this.acquireByteTarget(width, height);
    this.runFinish(recipe, graded, low, null, target, width, height, false, false);
    const pixels = this.readBack(target, width, height);
    return new ImageData(pixels, width, height, { colorSpace: recipe.output.space });
  }

  /**
   * Measure the result rather than predict it.
   *
   * The guardrails report what the output actually contains, so the numbers stay
   * honest as stages are added instead of drifting away from a formula written
   * against the sliders. Text is left out: a white caption is not a blown
   * highlight, and counting it as one would make the reading useless exactly
   * when somebody adds one.
   */
  measure(recipe: Recipe): RenderStats {
    const source = this.requireSource();
    const [cropW, cropH] = croppedSize(source.width, source.height, recipe.geometry);
    const [width, height] = fitWidth(cropW, cropH, MEASURE_WIDTH);
    const spec: FrameSpec = {
      width,
      height,
      matrix: outputToSource(source.width, source.height, recipe.geometry),
      key: geometrySignature(recipe.geometry),
    };
    const ctx = this.context(recipe, spec);
    const variant = variantKey(spec);
    const graded = this.dag.evaluate(ctx, recipe, 'grade', variant);
    const low = this.dag.evaluate(ctx, recipe, 'low', variant);

    const target = this.acquireByteTarget(width, height);
    this.runFinish(recipe, graded, low, null, target, width, height, false, false);

    const pixels = new Uint8Array(width * height * 4);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.framebuffer);
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

    return summarise(pixels);
  }

  /**
   * The tone response of the current grade, sampled as 256 output levels.
   *
   * The curve shown in the panel is measured by pushing a ramp through the same
   * shader the photo goes through, rather than re-deriving the tone maths in
   * TypeScript. A second implementation would be a second thing to keep in step,
   * and the one that is easy to forget is the one being drawn.
   *
   * Everything that depends on where a pixel is — the vignette above all — is
   * off, because a curve is a statement about a level and not about a corner.
   */
  toneResponse(recipe: Recipe): Uint8Array {
    const width = 256;
    this.syncCurve(recipe);
    const ramp = this.rampTexture();
    const graded = this.glctx.pool.acquire(width, 1);
    const uniforms = gradeUniforms(recipe, 1, this.curveKey);
    uniforms.vignette = 0;
    drawGrade(this.programs, this.glctx, uniforms, this.curveTexture, ramp, graded, width, 1);

    const target = this.acquireByteTarget(width, 1);
    this.programs.finish
      .bind()
      .texture('uSource', graded.texture)
      .texture('uLow', graded.texture)
      .texture('uText', graded.texture)
      .float('uSharpen', 0)
      .vec2('uSharpenStep', 0, 0)
      .float('uClarity', 0)
      .float('uGlow', 0)
      .float('uGlowThreshold', 1)
      .float('uGrain', 0)
      .float('uGrainSize', 1)
      .vec2('uResolution', width, 1)
      .int('uToSrgb', recipe.output.space === 'srgb' || !this.glctx.wideGamut ? 1 : 0)
      .int('uFlipY', 0)
      .int('uDither', 0)
      .int('uHasText', 0);
    this.glctx.draw(target, width, 1);

    const pixels = new Uint8Array(width * 4);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.framebuffer);
    this.gl.readPixels(0, 0, width, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.glctx.pool.release(graded);
    return pixels;
  }

  dispose(): void {
    this.dag.invalidate();
    if (this.ramp) this.gl.deleteTexture(this.ramp);
    if (this.source) this.gl.deleteTexture(this.source.texture);
    if (this.curveTexture) this.gl.deleteTexture(this.curveTexture);
    if (this.textTexture) this.gl.deleteTexture(this.textTexture);
    for (const target of this.byteTargets.values()) {
      this.gl.deleteTexture(target.texture);
      this.gl.deleteFramebuffer(target.framebuffer);
    }
    this.byteTargets.clear();
    for (const program of Object.values(this.programs)) program.dispose();
    this.glctx.dispose();
  }

  private requireSource(): SourceTexture {
    if (!this.source) throw new GlError('no source image loaded');
    return this.source;
  }

  /** Resolve the framing and the size it is evaluated at. */
  private frameSpec(recipe: Recipe, scale: RenderScale, fullFrame: boolean): FrameSpec {
    const source = this.requireSource();
    const geometry = recipe.geometry;
    const matrix = fullFrame
      ? frameToSource(source.width, source.height, geometry)
      : outputToSource(source.width, source.height, geometry);
    const [baseW, baseH] = fullFrame
      ? frameSize(source.width, source.height, geometry)
      : croppedSize(source.width, source.height, geometry);

    let width: number;
    let height: number;
    if (scale === 'proxy') {
      [width, height] = fitLongEdge(baseW, baseH, PROXY_LONG_EDGE);
    } else if (fullFrame) {
      width = Math.max(1, Math.round(baseW));
      height = Math.max(1, Math.round(baseH));
    } else {
      const plan = planExport(source.width, source.height, recipe);
      width = plan.width;
      height = plan.height;
    }

    return {
      width,
      height,
      matrix,
      key: `${geometrySignature(geometry)}:${fullFrame ? 'frame' : 'crop'}`,
    };
  }

  private context(recipe: Recipe, spec: FrameSpec): PassContext {
    this.syncCurve(recipe);
    return {
      gl: this.gl,
      glctx: this.glctx,
      programs: this.programs,
      source: this.requireSource(),
      width: spec.width,
      height: spec.height,
      geometry: spec.matrix,
      geometryKey: spec.key,
      curve: this.curveTexture,
      curveKey: this.curveKey,
    };
  }

  /** Rebuild the curve lookup only when the control points actually moved. */
  private syncCurve(recipe: Recipe): void {
    const points = recipe.global.curve;
    if (isIdentityCurve(points)) {
      this.curveKey = 'identity';
      return;
    }
    const key = JSON.stringify(points);
    if (key === this.curveKey && this.curveTexture) return;
    if (this.curveTexture) this.gl.deleteTexture(this.curveTexture);
    this.curveTexture = createLutTexture(this.gl, buildCurveLut(points));
    this.curveKey = key;
  }

  /** Rasterise the text layers at the size they are about to be composited at. */
  private syncText(recipe: Recipe, width: number, height: number): WebGLTexture | null {
    const key = textSignature(recipe.text, width, height);
    if (key === 'none') return null;
    if (key === this.textKey && this.textTexture) return this.textTexture;
    const data = rasterizeText(recipe.text, width, height);
    if (!data) return null;
    if (this.textTexture) this.gl.deleteTexture(this.textTexture);
    this.textTexture = createTextTexture(this.gl, width, height, data);
    this.textKey = key;
    return this.textTexture;
  }

  /** A 256-step display-referred ramp, used to probe the tone response. */
  private rampTexture(): WebGLTexture {
    if (this.ramp) return this.ramp;
    const pixels = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      pixels[i * 4] = i;
      pixels[i * 4 + 1] = i;
      pixels[i * 4 + 2] = i;
      pixels[i * 4 + 3] = 255;
    }
    this.ramp = createSourceTexture(this.gl, 256, 1, pixels);
    return this.ramp;
  }

  private readBack(
    target: RenderTarget,
    width: number,
    height: number,
  ): Uint8ClampedArray<ArrayBuffer> {
    const pixels = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.framebuffer);
    this.gl.readPixels(
      0,
      0,
      width,
      height,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      new Uint8Array(pixels.buffer),
    );
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    return pixels;
  }

  /**
   * Eight-bit destinations for readback, kept per size.
   *
   * The measurement, the thumbnails and the export all want a different size and
   * all recur, so a single slot would reallocate a texture on every settle.
   */
  private acquireByteTarget(width: number, height: number): RenderTarget {
    const key = `${width}x${height}`;
    const existing = this.byteTargets.get(key);
    if (existing) return existing;
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new GlError('could not create readback target');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const target: RenderTarget = { texture, framebuffer, width, height };
    // Only the full-resolution export target is large; keeping a handful of the
    // small ones costs little next to reallocating one every settle.
    if (this.byteTargets.size >= 6) {
      const [oldestKey, oldest] = [...this.byteTargets.entries()][0] as [string, RenderTarget];
      gl.deleteTexture(oldest.texture);
      gl.deleteFramebuffer(oldest.framebuffer);
      this.byteTargets.delete(oldestKey);
    }
    this.byteTargets.set(key, target);
    return target;
  }

  private runFinish(
    recipe: Recipe,
    graded: RenderTarget,
    low: RenderTarget,
    text: WebGLTexture | null,
    target: RenderTarget | null,
    width: number,
    height: number,
    flipY: boolean,
    original: boolean,
  ): void {
    const g = recipe.global;
    // Sharpening works on neighbouring pixels, so its radius is scaled with the
    // render size: without this the proxy would show a one-pixel effect standing
    // in for the four-pixel one the export gets, and the preview would be a
    // promise the file does not keep.
    const radius = Math.max(1, Math.round(width / PROXY_LONG_EDGE));
    this.programs.finish
      .bind()
      .texture('uSource', graded.texture)
      .texture('uLow', low.texture)
      .texture('uText', text ?? graded.texture)
      .float('uSharpen', original ? 0 : g.sharpen)
      .vec2('uSharpenStep', radius / width, radius / height)
      .float('uClarity', original ? 0 : g.clarity)
      .float('uGlow', original ? 0 : g.glow.amount)
      .float('uGlowThreshold', g.glow.threshold)
      .float('uGrain', original ? 0 : g.grain.amount)
      .float('uGrainSize', g.grain.size * Math.max(1, width / PROXY_LONG_EDGE) * 2)
      .vec2('uResolution', width, height)
      .int('uToSrgb', recipe.output.space === 'srgb' || !this.glctx.wideGamut ? 1 : 0)
      .int('uFlipY', flipY ? 1 : 0)
      .int('uDither', 1)
      .int('uHasText', text ? 1 : 0);
    this.glctx.draw(target, width, height);
  }
}

function variantKey(spec: FrameSpec): string {
  return `${spec.width}x${spec.height}:${spec.key}`;
}

/** Run the grade shader. Shared by the graph node and the tone-response probe. */
function drawGrade(
  programs: Programs,
  glctx: GlContext,
  uniforms: GradeUniforms,
  curve: WebGLTexture | null,
  sourceTexture: WebGLTexture,
  target: RenderTarget | null,
  width: number,
  height: number,
): void {
  const useCurve = uniforms.curveKey !== 'identity' && curve !== null;
  const program = programs.grade.bind().texture('uSource', sourceTexture);
  if (useCurve && curve) program.texture('uCurve', curve);
  program
    .float('uExposure', uniforms.exposure)
    .float('uContrast', uniforms.contrast)
    .float('uHighlights', uniforms.highlights)
    .float('uShadows', uniforms.shadows)
    .float('uWhites', uniforms.whites)
    .float('uBlacks', uniforms.blacks)
    .float('uTemperature', uniforms.temperature)
    .float('uTint', uniforms.tint)
    .float('uVibrance', uniforms.vibrance)
    .float('uSaturation', uniforms.saturation)
    .float('uSkinProtect', uniforms.skinProtect)
    .vec3Array('uHsl', new Float32Array(uniforms.hsl))
    .int('uUseHsl', uniforms.useHsl ? 1 : 0)
    .float('uMonoAmount', uniforms.monoAmount)
    .vec3('uMonoWeights', ...uniforms.monoWeights)
    .float('uSplitShadowHue', uniforms.splitShadowHue)
    .float('uSplitShadowAmount', uniforms.splitShadowAmount)
    .float('uSplitHighlightHue', uniforms.splitHighlightHue)
    .float('uSplitHighlightAmount', uniforms.splitHighlightAmount)
    .float('uSplitBalance', uniforms.splitBalance)
    .float('uFade', uniforms.fade)
    .float('uVignette', uniforms.vignette)
    .float('uVignetteMid', uniforms.vignetteMid)
    .float('uVignetteFeather', uniforms.vignetteFeather)
    .float('uVignetteRound', uniforms.vignetteRound)
    .float('uAspect', uniforms.aspect)
    .int('uUseCurve', useCurve ? 1 : 0);
  glctx.draw(target, width, height);
}

/**
 * The graph.
 *
 * `low` is the chain that produces the blurred reference clarity and glow work
 * against. It is built at a fixed width so its radius is a constant fraction of
 * the image: the same recipe then means the same amount of local contrast
 * whether it is being previewed at 1024 pixels or exported at twelve megapixels.
 */
function buildNodes(): DagNode<PassContext, RenderTarget, Recipe>[] {
  const ingest: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'ingest',
    inputs: [],
    signature: (_recipe, ctx) =>
      `ingest:${ctx.source.generation}:${ctx.width}x${ctx.height}:${ctx.source.fromSrgb}:${ctx.geometryKey}`,
    evaluate: (ctx) => {
      const target = ctx.glctx.pool.acquire(ctx.width, ctx.height);
      ctx.programs.ingest
        .bind()
        .texture('uSource', ctx.source.texture)
        .mat3('uGeometry', ctx.geometry)
        .int('uFromSrgb', ctx.source.fromSrgb ? 1 : 0);
      ctx.glctx.draw(target, ctx.width, ctx.height);
      return target;
    },
  };

  const grade: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'grade',
    inputs: ['ingest'],
    signature: (recipe, ctx) =>
      `grade:${JSON.stringify(gradeUniforms(recipe, ctx.width / ctx.height, ctx.curveKey))}`,
    evaluate: (ctx, [input], recipe) => {
      const src = input as RenderTarget;
      const target = ctx.glctx.pool.acquire(ctx.width, ctx.height);
      drawGrade(
        ctx.programs,
        ctx.glctx,
        gradeUniforms(recipe, ctx.width / ctx.height, ctx.curveKey),
        ctx.curve,
        src.texture,
        target,
        ctx.width,
        ctx.height,
      );
      return target;
    },
  };

  const lowSmall: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'lowSmall',
    inputs: ['grade'],
    signature: (_recipe, ctx) => `lowSmall:${lowSize(ctx).join('x')}`,
    evaluate: (ctx, [input]) => {
      const src = input as RenderTarget;
      const [width, height] = lowSize(ctx);
      const target = ctx.glctx.pool.acquire(width, height);
      ctx.programs.copy.bind().texture('uSource', src.texture);
      ctx.glctx.draw(target, width, height);
      return target;
    },
  };

  const lowH: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'lowH',
    inputs: ['lowSmall'],
    signature: (_recipe, ctx) => `lowH:${lowSize(ctx).join('x')}`,
    evaluate: (ctx, [input]) => {
      const src = input as RenderTarget;
      const target = ctx.glctx.pool.acquire(src.width, src.height);
      ctx.programs.blur
        .bind()
        .texture('uSource', src.texture)
        .vec2('uStep', 1 / src.width, 0);
      ctx.glctx.draw(target, src.width, src.height);
      return target;
    },
  };

  const low: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'low',
    inputs: ['lowH'],
    signature: (_recipe, ctx) => `low:${lowSize(ctx).join('x')}`,
    evaluate: (ctx, [input]) => {
      const src = input as RenderTarget;
      const target = ctx.glctx.pool.acquire(src.width, src.height);
      ctx.programs.blur
        .bind()
        .texture('uSource', src.texture)
        .vec2('uStep', 0, 1 / src.height);
      ctx.glctx.draw(target, src.width, src.height);
      return target;
    },
  };

  return [ingest, grade, lowSmall, lowH, low];
}

function lowSize(ctx: PassContext): [number, number] {
  return fitWidth(ctx.width, ctx.height, LOW_FREQUENCY_WIDTH);
}

/** Turn a small readback into the numbers the guardrails display. */
function summarise(pixels: Uint8Array): RenderStats {
  const count = pixels.length / 4;
  const histogram = new Uint32Array(64);
  let highlight = 0;
  let shadow = 0;
  let chroma = 0;
  let sum = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] as number;
    const g = pixels[i + 1] as number;
    const b = pixels[i + 2] as number;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max >= 254) highlight++;
    if (min <= 1) shadow++;
    // A channel pinned at an end while the others are not is what a colour
    // driven past the output gamut looks like once it has been clamped.
    if ((max >= 255 || min <= 0) && max - min > 24) chroma++;
    const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
    sum += y;
    histogram[Math.min(63, Math.floor(y * 64))] =
      (histogram[Math.min(63, Math.floor(y * 64))] ?? 0) + 1;
  }

  return {
    highlightClip: highlight / count,
    shadowClip: shadow / count,
    chromaClip: chroma / count,
    histogram,
    meanLuma: sum / count,
  };
}
