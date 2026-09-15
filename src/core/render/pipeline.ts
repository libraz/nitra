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

import type { FaceAnalysis } from '../face/analyze';
import { planExport } from '../geometry/tiles';
import {
  croppedSize,
  frameSize,
  frameToSource,
  geometrySignature,
  outputToSource,
} from '../geometry/transform';
import { Dag } from '../graph/dag';
import type { SourceImage } from '../io/decode';
import { buildCurveLut } from '../recipe/curve';
import { isIdentityCurve, isSkinNeutral, type Recipe } from '../recipe/schema';
import { rasterizeText, textSignature } from '../text/raster';
import type {
  FaceStats,
  FaceTextures,
  FrameSpec,
  PassContext,
  Programs,
  RenderOptions,
  RenderScale,
  RenderStats,
  SourceTexture,
  SubjectTextures,
} from './context';
import {
  createGlContext,
  createLutTexture,
  createMaskTexture,
  createSegmentationTexture,
  createSourceTexture,
  createTextTexture,
  type GlContext,
  GlError,
  Program,
  type RenderTarget,
} from './gl';
import { buildNodes, drawGrade } from './graph';
import {
  BOKEH_FRAGMENT,
  BOKEH_GATHER_FRAGMENT,
  BOKEH_LIFT_FRAGMENT,
  SUBJECT_RAW_FRAGMENT,
} from './shaders/bokeh';
import {
  BOX_BLUR_FRAGMENT,
  FACE_COEFF_FRAGMENT,
  FACE_DEVIATION_FRAGMENT,
  FACE_MASK_APPLY_FRAGMENT,
  FACE_MASK_COEFF_FRAGMENT,
  FACE_MASK_DEVIATION_FRAGMENT,
  FACE_MASK_RAW_FRAGMENT,
  FACE_MEAN_FRAGMENT,
  FACE_PARTS_FRAGMENT,
  FACE_PROBE_FRAGMENT,
  FACE_SKIN_FRAGMENT,
  FACE_TEXTURE_FRAGMENT,
  FACE_WARP_FIELD_FRAGMENT,
  FACE_WARP_FRAGMENT,
} from './shaders/face';
import {
  BLUR_FRAGMENT,
  COPY_FRAGMENT,
  FINISH_FRAGMENT,
  GRADE_FRAGMENT,
  INGEST_FRAGMENT,
} from './shaders/passes';
import {
  clampRadius,
  FACE_FILTER_EDGE,
  fitLongEdge,
  fitWidth,
  gradeUniforms,
  isWarping,
  MASK_EPSILON,
  rectOf,
} from './uniforms';

export type { FaceStats, RenderOptions, RenderScale, RenderStats } from './context';

/** Longest edge of the interactive proxy. */
export const PROXY_LONG_EDGE = 1024;

/** Width the guardrail measurement is taken at. */
const MEASURE_WIDTH = 256;

/** Feather on the skin mask, as a fraction of the face width. */
const MASK_FEATHER = 0.01;

/** Radius the mask is refined over, as a fraction of the face width. */
const MASK_REFINE_RADIUS = 0.02;

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
  private face: FaceTextures | null = null;
  private subject: SubjectTextures | null = null;

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
      boxBlur: Program.create(this.gl, BOX_BLUR_FRAGMENT),
      faceMean: Program.create(this.gl, FACE_MEAN_FRAGMENT),
      faceDeviation: Program.create(this.gl, FACE_DEVIATION_FRAGMENT),
      faceCoeff: Program.create(this.gl, FACE_COEFF_FRAGMENT),
      faceMaskRaw: Program.create(this.gl, FACE_MASK_RAW_FRAGMENT),
      faceMaskDeviation: Program.create(this.gl, FACE_MASK_DEVIATION_FRAGMENT),
      faceMaskCoeff: Program.create(this.gl, FACE_MASK_COEFF_FRAGMENT),
      faceMaskApply: Program.create(this.gl, FACE_MASK_APPLY_FRAGMENT),
      warpField: Program.create(this.gl, FACE_WARP_FIELD_FRAGMENT),
      warp: Program.create(this.gl, FACE_WARP_FRAGMENT),
      skin: Program.create(this.gl, FACE_SKIN_FRAGMENT),
      parts: Program.create(this.gl, FACE_PARTS_FRAGMENT),
      subjectRaw: Program.create(this.gl, SUBJECT_RAW_FRAGMENT),
      bokehLift: Program.create(this.gl, BOKEH_LIFT_FRAGMENT),
      bokehGather: Program.create(this.gl, BOKEH_GATHER_FRAGMENT),
      bokeh: Program.create(this.gl, BOKEH_FRAGMENT),
      faceTexture: Program.create(this.gl, FACE_TEXTURE_FRAGMENT),
      faceProbe: Program.create(this.gl, FACE_PROBE_FRAGMENT),
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

  /** True once the analysis has run and there is a face to work inside. */
  get hasFace(): boolean {
    return this.face !== null && this.face.faceCount > 0;
  }

  setSource(image: SourceImage): void {
    this.dag.invalidate();
    if (this.source) this.gl.deleteTexture(this.source.texture);
    // The masks describe the photo that is going away.
    this.setFaceAnalysis(null);
    this.generation += 1;
    this.source = {
      texture: createSourceTexture(this.gl, image.width, image.height, image.data),
      width: image.width,
      height: image.height,
      fromSrgb: image.space === 'srgb',
      generation: this.generation,
    };
  }

  /**
   * Take delivery of the analysis, and refine the skin mask.
   *
   * The refinement happens here rather than in the effect graph because nothing
   * about it depends on the framing or on a slider: it is a property of the
   * photo. Running it once on arrival is also what keeps it out of the drag
   * loop, where nine passes over a mask would be felt.
   *
   * The two halves of the result are taken separately on purpose. A photograph
   * with no face in it still has a person in it often enough — turned away, or
   * too small for the mesh — and the division between them and the room behind
   * them is exactly as good either way. So the segmentation is kept whenever it
   * describes the photo on screen, and only the face half needs a face.
   *
   * Passing null is how a failed analysis and a replaced source are expressed.
   * The stages then have no mask and switch themselves off, which is a
   * different thing from having a mask that is empty: an empty mask still costs
   * a pass over every pixel.
   */
  setFaceAnalysis(analysis: FaceAnalysis | null): void {
    if (this.face) {
      this.glctx.pool.release(this.face.mask);
      this.gl.deleteTexture(this.face.polyA);
      this.gl.deleteTexture(this.face.polyB);
    }
    if (this.subject) this.gl.deleteTexture(this.subject.segment);
    this.face = null;
    this.subject = null;
    // Every cached result downstream of the masks was rendered without them.
    this.dag.invalidate();

    const source = this.source;
    if (!analysis || !source) return;
    // An analysis of a different photo would put a mask over the wrong face.
    if (analysis.sourceWidth !== source.width || analysis.sourceHeight !== source.height) return;

    this.subject = {
      segment: createSegmentationTexture(
        this.gl,
        analysis.segmentation.width,
        analysis.segmentation.height,
        analysis.segmentation.data,
      ),
      key: `${analysis.revision}`,
    };

    if (analysis.faces.length === 0) return;

    const [maskWidth, maskHeight] = [analysis.masks[0].width, analysis.masks[0].height];
    const regionPixels: [number, number] = [
      Math.max(1, Math.round(analysis.region.width * source.width)),
      Math.max(1, Math.round(analysis.region.height * source.height)),
    ];
    const polyA = createMaskTexture(
      this.gl,
      analysis.masks[0].width,
      analysis.masks[0].height,
      analysis.masks[0].data,
    );
    const polyB = createMaskTexture(
      this.gl,
      analysis.masks[1].width,
      analysis.masks[1].height,
      analysis.masks[1].data,
    );
    this.face = {
      mask: this.refineMask(polyA, this.subject.segment, analysis, maskWidth, maskHeight),
      polyA,
      polyB,
      faceWidth: analysis.faceWidth,
      faceCount: analysis.faces.length,
      faces: analysis.faces,
      aspect: analysis.sourceHeight / analysis.sourceWidth,
      region: analysis.region,
      regionPixels,
      key: `${analysis.revision}`,
    };
  }

  /**
   * Snap the mask's edges onto the photo, then feather it.
   *
   * The segmentation arrives 256 pixels across and magnifying it leaves a halo
   * a whole face wide; the outlines are exact but know nothing about hair. A
   * guided filter against the photo's own lightness resolves both at once —
   * it moves the boundary onto the structure that is actually there.
   *
   * The feather is last and is a fraction of the face width, so it is the same
   * softness on the next photo. It is also the single thing most likely to be
   * noticed: too hard and there is a seam along the jaw, too soft and the
   * effect reaches the background.
   */
  private refineMask(
    polyA: WebGLTexture,
    segment: WebGLTexture,
    analysis: FaceAnalysis,
    width: number,
    height: number,
  ): RenderTarget {
    const source = this.requireSource();
    const pool = this.glctx.pool;
    const region = analysis.region;
    // The radii are fractions of the face, and the working area holds the face
    // at a known fraction of itself, so they land on the same number of texels
    // whatever size the photograph is.
    const perWidth = width / Math.max(region.width, 1e-4);
    const radius = clampRadius(analysis.faceWidth * MASK_REFINE_RADIUS * perWidth, 1);
    const box = rectOf(region);

    const raw = pool.acquire(width, height);
    this.programs.faceMaskRaw
      .bind()
      .vec4('uRegion', ...box)
      .texture('uPoly', polyA)
      .texture('uSegment', segment)
      .texture('uImage', source.texture)
      .float('uSegmentWeight', analysis.segmentationWeight);
    this.glctx.draw(raw, width, height);

    const means = this.boxBlur(raw, radius, false);
    const deviation = pool.acquire(width, height);
    this.programs.faceMaskDeviation
      .bind()
      .texture('uSource', raw.texture)
      .texture('uMean', means.texture);
    this.glctx.draw(deviation, width, height);
    pool.release(raw);

    const spread = this.boxBlur(deviation, radius, true);
    const coeff = pool.acquire(width, height);
    this.programs.faceMaskCoeff
      .bind()
      .texture('uMean', means.texture)
      .texture('uDeviation', spread.texture)
      .float('uEpsilon', MASK_EPSILON);
    this.glctx.draw(coeff, width, height);
    pool.release(spread);
    pool.release(means);

    const smoothed = this.boxBlur(coeff, radius, true);
    const applied = pool.acquire(width, height);
    this.programs.faceMaskApply
      .bind()
      .vec4('uRegion', ...box)
      .texture('uCoeff', smoothed.texture)
      .texture('uImage', source.texture);
    this.glctx.draw(applied, width, height);
    pool.release(smoothed);

    const feather = clampRadius(analysis.faceWidth * MASK_FEATHER * perWidth, 1);
    const mask = this.boxBlur(applied, feather, true);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    return mask;
  }

  /**
   * Box blur a target in both directions.
   *
   * @param consume Release the input once it has been read, which is what the
   * intermediate steps of a filter chain want: nothing else will ask for it.
   */
  private boxBlur(input: RenderTarget, radius: number, consume: boolean): RenderTarget {
    const pool = this.glctx.pool;
    const { width, height } = input;
    const horizontal = pool.acquire(width, height);
    this.programs.boxBlur
      .bind()
      .texture('uSource', input.texture)
      .vec2('uStep', 1 / width, 0)
      .int('uRadius', radius);
    this.glctx.draw(horizontal, width, height);
    if (consume) pool.release(input);

    const vertical = pool.acquire(width, height);
    this.programs.boxBlur
      .bind()
      .texture('uSource', horizontal.texture)
      .vec2('uStep', 0, 1 / height)
      .int('uRadius', radius);
    this.glctx.draw(vertical, width, height);
    pool.release(horizontal);
    return vertical;
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

    return {
      ...summarise(pixels),
      textureRetention: this.measureTextureRetention(recipe),
    };
  }

  /**
   * How much of the skin's texture the face stages left behind.
   *
   * Measured against the photo as it arrived, inside the skin mask. Nothing is
   * forbidden by it: a number saying the pores are gone is enough for somebody
   * to pull the slider back, and the design's whole position on overcorrection
   * is to show it rather than to prevent it.
   *
   * It is measured over the face rather than over the frame, and that is what
   * makes the number mean anything. The other guardrails read a 256-pixel
   * render because clipping and saturation are properties of the whole picture;
   * skin texture is not. A face a fifteenth of the width of the frame is
   * fifteen pixels wide in that render, and fifteen pixels of face have no pores
   * in them to have kept or lost — the reading came back near one whatever the
   * slider did. Over the working area, at the resolution the filter itself runs
   * at, the pores are present and the difference is the thing being asked about.
   *
   * A consequence worth knowing: the reading does not depend on the framing.
   * Cropping cannot change how much texture was left on the skin, so it does not
   * move the number — which also stops the gauge twitching while a crop is being
   * dragged.
   *
   * What it compares against is the reshaped frame, not the photograph. Both
   * sides are then resampled the same way and the difference between them is the
   * face stages alone. Compared against the photograph, slimming a face would
   * show up here as texture the smoothing had taken — the reading would fall
   * while the slider it is reporting on had not moved.
   *
   * Returns null when there is nothing to say — no face, or a face the stages
   * are not touching. An absent reading and a reading of one are different
   * claims.
   */
  private measureTextureRetention(recipe: Recipe): number | null {
    const face = this.face;
    if (!face || isSkinNeutral(recipe.face)) return null;

    const [width, height] = fitLongEdge(...face.regionPixels, FACE_FILTER_EDGE);
    const spec: FrameSpec = {
      width,
      height,
      // Straight from the working area to the source, with no framing in it:
      // the output coordinate of this render is the working area itself.
      matrix: [face.region.width, 0, face.region.x, 0, face.region.height, face.region.y, 0, 0, 1],
      key: `faceRegion:${face.key}`,
    };
    const ctx = this.context(recipe, spec);
    const variant = variantKey(spec);
    const before = this.dag.evaluate(ctx, recipe, 'warp', variant);
    const after = this.dag.evaluate(ctx, recipe, 'parts', variant);
    const field = this.dag.evaluate(ctx, recipe, 'warpField', variant);
    const target = this.acquireByteTarget(width, height);
    this.programs.faceTexture
      .bind()
      .vec4('uRegion', ...rectOf(face.region))
      .texture('uBefore', before.texture)
      .texture('uAfter', after.texture)
      .texture('uMask', face.mask.texture)
      .texture('uWarp', field.texture)
      .int('uWarped', isWarping(recipe, ctx) ? 1 : 0)
      .mat3('uGeometry', ctx.geometry)
      .vec2('uStep', 1 / width, 1 / height);
    this.glctx.draw(target, width, height);

    const pixels = new Uint8Array(width * height * 4);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.framebuffer);
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

    let kept = 0;
    let weight = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      kept += pixels[i] as number;
      weight += pixels[i + 1] as number;
    }
    // Too little textured skin in the frame to say anything about it.
    if (weight < 255) return null;
    return kept / weight;
  }

  /**
   * Measure the skin, for the automatic starting values.
   *
   * This is the half of the automatic suggestion that the frame's histogram
   * cannot provide. Whether a photo is dark and whether the person in it is
   * dark are different questions, and only the second one is answered by
   * looking at the skin.
   *
   * Runs off a recipe as given, so the caller decides whether it is probing the
   * untouched photo or the edited one. Like every other readback, it is not
   * reachable from a slider.
   */
  measureFace(recipe: Recipe): FaceStats | null {
    const face = this.face;
    if (!face || face.faceCount === 0) return null;
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
    const image = this.dag.evaluate(ctx, recipe, 'ingest', variant);
    // Asked for by name, because under a neutral recipe the stages that would
    // otherwise pull these in are switched off.
    const mean = this.dag.evaluate(ctx, recipe, 'faceMeanV', variant);
    const wide = this.dag.evaluate(ctx, recipe, 'faceWideMean', variant);

    const sum = (surround: boolean): [number, number, number, number] => {
      const target = this.acquireByteTarget(width, height);
      this.programs.faceProbe
        .bind()
        .vec4('uRegion', ...rectOf(face.region))
        .texture('uSource', image.texture)
        .texture('uMask', face.mask.texture)
        .texture('uMean', mean.texture)
        .texture('uWideMean', wide.texture)
        // The untouched photograph, read with the masks as they were built, so
        // the displacement is switched off and the sampler bound to something
        // valid that is never read. What the starting values are proposed from
        // is the skin the camera recorded; moving a jaw does not change it.
        .texture('uWarp', image.texture)
        .int('uWarped', 0)
        .mat3('uGeometry', ctx.geometry)
        .int('uSurround', surround ? 1 : 0);
      this.glctx.draw(target, width, height);
      const pixels = new Uint8Array(width * height * 4);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.framebuffer);
      this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      let lightness = 0;
      let uneven = 0;
      let specular = 0;
      let covered = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        lightness += pixels[i] as number;
        uneven += pixels[i + 1] as number;
        specular += pixels[i + 2] as number;
        covered += pixels[i + 3] as number;
      }
      return [lightness, uneven, specular, covered];
    };

    const [skinL, uneven, specular, covered] = sum(false);
    const [surroundL, , , outside] = sum(true);
    const count = width * height * 255;
    // A mask that covers next to nothing is a detection that found something
    // the segmentation disagreed with, and averaging over it is meaningless.
    if (covered < count * 0.002) return null;

    // Every channel came out of the shader already multiplied by the weight in
    // the fourth, so dividing one by the other is the weighted mean and there is
    // no scale left to take out: the byte range cancels. All four go through the
    // same expression so that a stray factor has nowhere to hide — one of them
    // normalised twice reads as a plausible number rather than as a wrong one,
    // and it was the two lightnesses, which then never reached the margins the
    // automatic suggestion compares them against.
    const perWeight = (total: number, weight: number) => (weight > 0 ? total / weight : 0);
    return {
      faceCount: face.faceCount,
      coverage: covered / count,
      skinLightness: perWeight(skinL, covered),
      surroundLightness: perWeight(surroundL, outside),
      unevenness: perWeight(uneven, covered),
      specular: perWeight(specular, covered),
    };
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
    this.setFaceAnalysis(null);
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
      face: this.face,
      subject: this.subject,
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

/** Turn a small readback into the numbers the guardrails display. */
function summarise(pixels: Uint8Array): Omit<RenderStats, 'textureRetention'> {
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
