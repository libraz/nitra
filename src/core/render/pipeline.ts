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
import { warpControlPoints } from '../face/warp';
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
import { SourcePlate } from '../plate/plate';
import { cutOut } from '../plate/region';
import { buildCurveLut } from '../recipe/curve';
import {
  isIdentityCurve,
  isRestoreNeutral,
  isSkinNeutral,
  neutralRecipe,
  type Recipe,
  restoreSignature,
} from '../recipe/schema';
import { pairFaces } from '../restore/align';
import { type GraftFace, type GraftImage, graft } from '../restore/graft';
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
  RestoreReference,
  RestoreReport,
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
  updateSourceTexture,
} from './gl';
import { buildNodes, drawGrade, SKIN_SPREAD_REFERENCE } from './graph';
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
  FACE_LOCAL_FRAGMENT,
  FACE_MASK_APPLY_FRAGMENT,
  FACE_MASK_COEFF_FRAGMENT,
  FACE_MASK_DEVIATION_FRAGMENT,
  FACE_MASK_RAW_FRAGMENT,
  FACE_MEAN_FRAGMENT,
  FACE_PARTS_FRAGMENT,
  FACE_PROBE_FRAGMENT,
  FACE_SKIN_FRAGMENT,
  FACE_SPREAD_FRAGMENT,
  FACE_TEXTURE_FRAGMENT,
  FACE_WARP_FIELD_FRAGMENT,
  FACE_WARP_FRAGMENT,
} from './shaders/face';
import { HAIR_FRAGMENT, HAIR_RAW_FRAGMENT } from './shaders/hair';
import { RELIGHT_FRAGMENT } from './shaders/light';
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

export type {
  FaceStats,
  RenderOptions,
  RenderScale,
  RenderStats,
  RestoreReference,
  RestoreReport,
} from './context';

/** Longest edge of the interactive proxy. */
export const PROXY_LONG_EDGE = 1024;

/**
 * How the skin's spread is packed into eight bits on the way back.
 *
 * A standard deviation rather than a variance, so the range skin occupies is
 * spread over the byte evenly; this puts the calibration near a third of the
 * way up it and leaves room for skin several times noisier before the top
 * clips, which is past where the threshold's own bound has taken over anyway.
 */
const SKIN_SPREAD_SCALE = 8;

/** Width the guardrail measurement is taken at. */
const MEASURE_WIDTH = 256;

/** Feather on the skin mask, as a fraction of the face width. */
const MASK_FEATHER = 0.01;

/** Radius the mask is refined over, as a fraction of the face width. */
const MASK_REFINE_RADIUS = 0.02;

/**
 * Pixels the on-screen canvas may cover.
 *
 * Magnifying the view raises the canvas's own resolution rather than the size of
 * its box, so without a ceiling a zoomed look at a twelve-megapixel photo would
 * ask for a drawing buffer several times the size of the file. The number is a
 * limit on the browser's side as much as on the GPU's: mobile Safari refuses a
 * canvas past about sixteen million pixels outright, and a refusal is a blank
 * stage rather than a slow one.
 */
const CANVAS_PIXEL_BUDGET = 16_000_000;

/**
 * Device pixels per CSS pixel the canvas is drawn at.
 *
 * Two ceilings, and each says something different. Past the picture's own
 * resolution there are no more pixels to show, so asking for them buys nothing
 * and the magnification goes on in the compositor — which is the honest picture
 * of what looking at a photograph past its own pixels is. The budget is the
 * separate question of what the browser will allocate at all.
 */
function canvasDensity(wanted: number, cssWidth: number, cssHeight: number, limit: number): number {
  const density = Math.min(wanted, Math.max(1, limit) / Math.max(cssWidth, 1));
  const area = cssWidth * cssHeight * density * density;
  return area > CANVAS_PIXEL_BUDGET ? density * Math.sqrt(CANVAS_PIXEL_BUDGET / area) : density;
}

export class Pipeline {
  private readonly glctx: GlContext & { wideGamut: boolean };
  private readonly gl: WebGL2RenderingContext;
  private readonly programs: Programs;
  private readonly dag: Dag<PassContext, RenderTarget, Recipe>;
  private source: SourceTexture | null = null;
  private decoded: GraftImage | null = null;
  private plate: SourcePlate | null = null;
  private healed: SourceTexture | null = null;
  private reference: RestoreReference | null = null;
  /** The frame with the photographed faces in it, while there are any. */
  private restored: Uint8ClampedArray | null = null;
  private restoreKey = 'none';
  private restoreReport: RestoreReport | null = null;
  private generation = 0;
  private curveTexture: WebGLTexture | null = null;
  private curveKey = 'identity';
  private textTexture: WebGLTexture | null = null;
  private textKey = 'none';
  private readonly byteTargets = new Map<string, RenderTarget>();
  private ramp: WebGLTexture | null = null;
  private face: FaceTextures | null = null;
  private subject: SubjectTextures | null = null;
  private fitScaleValue: number | null = null;

  /**
   * CSS pixels the fitted picture occupies per pixel of the exported one.
   *
   * It is what turns the view's multiple of the fit size into the magnification
   * a photographer reads — a hundred per cent being one pixel of the file on one
   * pixel of the page — and it is measured here because the fit is measured
   * here. Null until a render has happened, since until then nothing has been
   * fitted to anything.
   */
  get fitScale(): number | null {
    return this.fitScaleValue;
  }

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
      faceLocal: Program.create(this.gl, FACE_LOCAL_FRAGMENT),
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
      hairRaw: Program.create(this.gl, HAIR_RAW_FRAGMENT),
      hair: Program.create(this.gl, HAIR_FRAGMENT),
      subjectRaw: Program.create(this.gl, SUBJECT_RAW_FRAGMENT),
      bokehLift: Program.create(this.gl, BOKEH_LIFT_FRAGMENT),
      bokehGather: Program.create(this.gl, BOKEH_GATHER_FRAGMENT),
      bokeh: Program.create(this.gl, BOKEH_FRAGMENT),
      faceTexture: Program.create(this.gl, FACE_TEXTURE_FRAGMENT),
      faceProbe: Program.create(this.gl, FACE_PROBE_FRAGMENT),
      faceSpread: Program.create(this.gl, FACE_SPREAD_FRAGMENT),
      relight: Program.create(this.gl, RELIGHT_FRAGMENT),
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
    this.dropHealed();
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
    this.decoded = {
      data: image.data,
      width: image.width,
      height: image.height,
      space: image.space,
    };
    // The reference is deliberately kept. One photograph against several
    // generated versions of it is the working shape, and reopening the original
    // for each of them would be the app forgetting something it is holding.
    this.restored = null;
    this.restoreKey = 'none';
    this.restoreReport = null;
    // The decoded pixels are held, not copied: they are the only record of what
    // is under a fill, and a copy is made only once something is filled.
    this.plate = new SourcePlate(image.data, image.width, image.height);
  }

  /**
   * Take delivery of the photograph the faces are restored from.
   *
   * Passing null is how the reference is put away. Neither this nor the recipe
   * alone switches the stage on: the recipe names a file and this supplies one,
   * and a recipe reopened without its reference renders the frame it was given.
   */
  setReference(reference: RestoreReference | null): void {
    this.reference = reference;
    // A value no key can be computed as, rather than the key for an idle stage:
    // putting the reference away has to *recompute* — to nothing, and so undo
    // the patch — and writing the idle key here would leave the next settle
    // agreeing it was already up to date with the face still pasted in. The
    // same applies in the other direction, to a reference reopened under the
    // name it already had after being changed on disk.
    this.restoreKey = 'stale';
  }

  /** What the last restore found, or null while none has run. */
  get lastRestore(): RestoreReport | null {
    return this.restoreReport;
  }

  /**
   * Bring the plate in line with the recipe: restore, then fill, then conceal.
   *
   * The order is the stage order and is not free to change. A blemish is filled
   * on the face that ends up in the picture, so a fill placed on a restored
   * cheek has to be applied after the cheek arrives; restoring second would fill
   * the generated face and then throw the result away. And a circle is the last
   * word inside itself, so it goes over the fills rather than under them — a
   * fill that put sharp structure back inside a ring would make the ring's
   * promise false.
   *
   * This is the only public way in, so the ordering lives here rather than in
   * each caller. Every part of it must run before an export for the same reason:
   * an export taken before a settle would write the generated face back in, or
   * the reflection.
   */
  async syncPlate(recipe: Recipe): Promise<void> {
    this.syncRestore(recipe);
    await this.syncSpots(recipe);
  }

  /**
   * Put the photographed faces back into the frame.
   *
   * A substituted source, like the fills and for the same reasons: it happens
   * once rather than per frame, it reads and writes pixels on the CPU, and every
   * stage downstream then reads the photograph it always reads. What it buys by
   * being here rather than at the end is the whole reason a patch stops looking
   * like one — the grade runs over the seam and the grain lands on it, so the
   * restored face is finished by the same pass as the frame around it.
   *
   * It is synchronous, and that is the contract rather than a description: it
   * runs from the settled render, never from a drag.
   */
  private syncRestore(recipe: Recipe): void {
    const decoded = this.decoded;
    if (!decoded) return;

    const reference = this.reference;
    const usable =
      !isRestoreNeutral(recipe.restore) &&
      reference !== null &&
      reference.fileName === recipe.restore.reference;
    // The analysis is named because it decides where the patch goes, and it
    // arrives after the first render: without it here, a restore asked for
    // before the models landed would never be reconsidered.
    const key = usable ? `${restoreSignature(recipe.restore)}:${this.face?.key ?? 'none'}` : 'none';
    if (key === this.restoreKey) return;

    // Everything that can fail happens before anything is assigned, so a graft
    // that throws leaves the renderer holding the state it already had rather
    // than a plate built on pixels nobody produced.
    let restored: Uint8ClampedArray | null = null;
    let report: RestoreReport | null = null;

    if (usable && this.face) {
      const target = this.face;
      const pairs = pairFaces(target.faces, reference.faces);
      report = {
        paired: pairs.length,
        unpaired: target.faces.length - pairs.length,
        residual: pairs.reduce((worst, pair) => Math.max(worst, pair.residual), 0),
      };
      const faces: GraftFace[] = pairs.flatMap((pair) => {
        const into = target.faces[pair.destination];
        const from = reference.faces[pair.reference];
        if (!into || !from) return [];
        return [
          { outline: into.oval, source: from.oval, width: into.width, transform: pair.transform },
        ];
      });
      restored = graft(decoded, reference.image, faces, recipe.restore.edge, recipe.restore.match);
    }

    this.restoreKey = key;
    const previous = this.restored;
    this.restored = restored;
    this.restoreReport = report;

    // Nothing to do when neither the old state nor the new one has a patch in
    // it, which is every settled render on a photograph nobody is restoring.
    if (!previous && !this.restored) return;

    // A different photograph as far as the graph is concerned, and the plate is
    // rebuilt on it: the fills are replayed onto the face that is now there.
    // That replay is the real cost of moving either of this stage's sliders —
    // every spot is filled again, since there is no fill to keep once what was
    // underneath it has changed.
    this.generation += 1;
    this.plate = new SourcePlate(this.restored ?? decoded.data, decoded.width, decoded.height);
    // The texture is left to the fills to build, even though the pixels are
    // already here. Uploading them now would be uploading them twice whenever a
    // spot exists, because rebuilding the plate makes the next step a rebuild
    // too, and at twelve megapixels that is a wasted forty-eight.
    this.dropHealed();
    this.dag.invalidate();
  }

  /**
   * Fill the spots and conceal the circles the recipe asks for, and put the
   * result on the GPU.
   *
   * A step the caller takes before rendering rather than a node in the graph.
   * Everything else is a shader the renderer can run inside a frame; these read
   * and write pixels on the CPU, and a render that happens before they have run
   * shows the photograph as it was, which is the right thing to show while the
   * work has not happened yet.
   *
   * The promise is the stage's contract rather than a description of what it
   * does: the fill does not yield, and while it runs nothing else does. Keeping
   * it is what would let the work move off the main thread without the
   * scheduler learning about it.
   *
   * It must never be awaited from a drag. The fill is tenths of a second at the
   * top of the brush's range, and a pixel read inside the loop is a slider that
   * stops following the pointer. Spots and circles are placed by a click, and
   * this runs on that click.
   *
   * What comes out is a second source texture standing in for the photograph.
   * Substituting the source is what puts the stages where the design fixes them
   * — ahead of the reshaping, which is why the coordinates are in the
   * photograph's own frame — and it means the stages downstream need to know
   * nothing about either of them: they read the source they always read.
   */
  private async syncSpots(recipe: Recipe): Promise<void> {
    const plate = this.plate;
    const source = this.source;
    if (!plate || !source) return;
    // The restore put faces back and left the upload to here, which is the one
    // way the plate can be ahead of the GPU without a spot having moved. It is
    // the same upload either way, and doing it in one place is what stops it
    // from happening twice when both stages have something to say.
    const pending = this.restored !== null && this.healed === null;
    // This runs on the way to every settled render, and almost none of them
    // placed anything.
    const { spots: circles, amount } = recipe.conceal;
    if (!pending && plate.matches(circles, amount, recipe.heal)) return;

    const update = plate.apply(circles, amount, recipe.heal);
    if (update === null && !pending) return;

    // The plate is null again once the last spot or circle goes, and what that
    // means depends on whether anything was restored: back to the photograph if
    // not, and back to the photograph with its own faces in it if so. Reading
    // the decoded pixels here would undo the restore whenever one was removed.
    const pixels = plate.pixels ?? this.restored;
    if (!pixels) {
      // Back to the photograph, and back to costing nothing.
      this.dropHealed();
      this.dag.invalidate();
      return;
    }
    // Nothing was reached: every new spot was smaller than a pixel, so the
    // texture already says what the plate says.
    if (update && !update.rebuilt && this.healed && update.rects.length === 0) return;

    // A new photograph as far as anything downstream is concerned, and the
    // cheapest way to say so: every signature that samples the source carries
    // this number.
    this.generation += 1;
    if (!update || update.rebuilt || !this.healed) {
      this.dropHealed();
      this.healed = {
        texture: createSourceTexture(this.gl, plate.width, plate.height, pixels),
        width: plate.width,
        height: plate.height,
        fromSrgb: source.fromSrgb,
        generation: this.generation,
      };
      return;
    }
    updateSourceTexture(
      this.gl,
      this.healed.texture,
      plate.width,
      plate.height,
      update.rects.map((region) => ({ ...region, data: cutOut(pixels, plate.width, region) })),
    );
    this.healed.generation = this.generation;
  }

  /** What the stages read as the photograph: the plate if there is one. */
  private photograph(): SourceTexture {
    return this.healed ?? this.requireSource();
  }

  private dropHealed(): void {
    if (this.healed) this.gl.deleteTexture(this.healed.texture);
    this.healed = null;
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
      this.gl.deleteTexture(this.face.normals);
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
    // The same kind of texture as the masks, and for the same reason: four
    // channels of bytes over the working area, sampled bilinearly.
    const normals = createMaskTexture(
      this.gl,
      analysis.normals.width,
      analysis.normals.height,
      analysis.normals.data,
    );
    this.face = {
      mask: this.refineMask(polyA, this.subject.segment, analysis, maskWidth, maskHeight),
      polyA,
      polyB,
      normals,
      faceWidth: analysis.faceWidth,
      faceCount: analysis.faces.length,
      faces: analysis.faces,
      aspect: analysis.sourceHeight / analysis.sourceWidth,
      region: analysis.region,
      regionPixels,
      // Stood in for until it has been measured, which cannot happen before the
      // mask it is measured through is here. Nothing is evaluated in between.
      spread: SKIN_SPREAD_REFERENCE,
      key: `${analysis.revision}`,
    };
    this.face = { ...this.face, spread: this.measureSkinSpread() };
  }

  /**
   * How much the skin's lightness varies inside one filter window.
   *
   * Taken once, on arrival, at the default radius — the same place and for the
   * same reason as the mask refinement above. The filter's threshold is set
   * against it, so it has to be a property of the photograph rather than of the
   * recipe: measured at whatever radius the recipe happened to hold, it would be
   * a readback on the radius slider, which is a readback in the drag loop.
   *
   * The variance is already accumulated inside the mask by the filter's own
   * chain, so this adds one pass and one read rather than a measurement of its
   * own. What comes back is a weighted sum and its weight, both as bytes, which
   * divide into the mask-weighted mean with the byte range cancelling.
   */
  private measureSkinSpread(): number {
    const face = this.face;
    if (!face) return SKIN_SPREAD_REFERENCE;
    const recipe = neutralRecipe();
    const [width, height] = fitLongEdge(...face.regionPixels, FACE_FILTER_EDGE);
    const spec: FrameSpec = {
      width,
      height,
      matrix: [face.region.width, 0, face.region.x, 0, face.region.height, face.region.y, 0, 0, 1],
      key: `faceRegion:${face.key}`,
    };
    const ctx = this.context(recipe, spec);
    const variance = this.dag.evaluate(ctx, recipe, 'faceDeviationV', variantKey(spec));

    const target = this.acquireByteTarget(variance.width, variance.height);
    this.programs.faceSpread
      .bind()
      .texture('uVariance', variance.texture)
      .float('uScale', SKIN_SPREAD_SCALE);
    this.glctx.draw(target, variance.width, variance.height);

    const pixels = new Uint8Array(variance.width * variance.height * 4);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.framebuffer);
    this.gl.readPixels(
      0,
      0,
      variance.width,
      variance.height,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      pixels,
    );
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

    let spread = 0;
    let weight = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      spread += pixels[i] as number;
      weight += pixels[i + 1] as number;
    }
    // Too little skin in the working area to have measured anything, which is a
    // mask that disagrees with the outline rather than a photograph with flat
    // skin — and the calibration is a better answer than a reading off nothing.
    if (weight < 255) return SKIN_SPREAD_REFERENCE;
    return spread / (weight * SKIN_SPREAD_SCALE);
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
    const ctx = this.context(recipe, spec, original);
    // The comparison is against the photograph, which since the Heal stage is a
    // different picture from the one the edit is built on. It gets its own
    // variant so that holding the button down does not evict the edit's chain:
    // one slot per node per variant, and these two disagree about the source.
    const variant = original ? `${variantKey(spec)}:decoded` : variantKey(spec);

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
    // The full-resolution size rather than this render's, so the canvas does not
    // resize between the proxy and the settled render: a backing store that grew
    // and shrank on every drag would reallocate the drawing buffer and pop.
    const limit = this.frameSpec(recipe, 'full', fullFrame).width;
    this.fitScaleValue = cssWidth / limit;
    const density = canvasDensity(dpr * Math.max(1, options.zoom ?? 1), cssWidth, cssHeight, limit);
    const bufferWidth = Math.max(1, Math.round(cssWidth * density));
    const bufferHeight = Math.max(1, Math.round(cssHeight * density));
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
      reshapeMagnitude: this.measureReshape(recipe, ctx),
    };
  }

  /**
   * How far the reshaping moves a face.
   *
   * The one guardrail that needs no pixels: the displacements are arithmetic
   * over the landmarks, so the same function the field is built from answers
   * it. Called again rather than carried out of the field pass, which cannot
   * disagree — it is a pure function of the faces and the amounts, and the
   * alternative is a second copy of the number in the pass context.
   */
  private measureReshape(recipe: Recipe, ctx: PassContext): number | null {
    if (!isWarping(recipe, ctx) || !ctx.face) return null;
    return warpControlPoints(ctx.face.faces, recipe.face.warp).magnitude;
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
    this.dropHealed();
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

  /**
   * @param asDecoded Read the photograph as it was decoded, healing and all
   * else aside. Only the comparison view wants this.
   */
  private context(recipe: Recipe, spec: FrameSpec, asDecoded = false): PassContext {
    this.syncCurve(recipe);
    return {
      gl: this.gl,
      glctx: this.glctx,
      programs: this.programs,
      source: asDecoded ? this.requireSource() : this.photograph(),
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
    reshapeMagnitude: null,
  };
}
