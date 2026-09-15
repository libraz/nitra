/**
 * The effect graph.
 *
 * One node per stage, in the order the design fixes them in, and the nodes are
 * the whole of what is cached. Everything a node needs arrives through the pass
 * context, so nothing here reaches back into the pipeline that evaluates it.
 */

import { warpControlPoints } from '../face/warp';
import type { DagNode } from '../graph/dag';
import { isPartsNeutral, isSkinNeutral, type Recipe } from '../recipe/schema';
import type { FaceTextures, PassContext, Programs, SubjectTextures } from './context';
import type { GlContext, RenderTarget } from './gl';
import {
  apertureIndex,
  bokehRadius,
  bokehSize,
  clampRadius,
  faceFilterSize,
  fitLongEdge,
  type GradeUniforms,
  gradeUniforms,
  isDefocusing,
  isWarping,
  lowSize,
  MASK_EPSILON,
  packControlPoints,
  partsUniforms,
  regionOf,
  skinRadius,
  skinUniforms,
  subjectRadius,
  subjectSize,
} from './uniforms';

/**
 * Longest edge of the displacement field.
 *
 * The field is smooth by construction — its narrowest feature is a control
 * point's own support, a tenth of a face across — so it is built small and
 * sampled bilinearly rather than evaluated per pixel at full size. What decides
 * the size is the smallest face worth reshaping: at this edge a face six per
 * cent of the frame gets around thirty pixels, which is about as small as a face
 * can be and still be one somebody is reshaping.
 *
 * It is held in the photograph's own frame rather than the rendered one, so the
 * same field serves the proxy, the export and the face-region passes, and a
 * crop cannot move the displacement relative to the face.
 */
const WARP_FIELD_EDGE = 512;

/**
 * How much variance the guided filter treats as texture rather than as an edge.
 *
 * The filter keeps a fraction `var / (var + this)` of what it is given, so this
 * is not a free parameter: it has to sit above the variance of skin and below
 * the variance of a feature, and those are measurable. Over a window the width
 * the radius asks for, skin lightness in Oklab varies by a few hundredths and
 * the eyes, brows and lips by a few times more, with the two distributions
 * meeting around six per cent. Squared, because it is compared against a
 * variance, that is the number below; it leaves typical skin about a seventh of
 * its detail and a feature edge about two thirds of its own.
 *
 * The danger of getting it wrong is one-sided and quiet. Too high and the face
 * flattens, which is obvious and what the texture guardrail measures. Too low
 * and the filter calls the whole face an edge and returns the photograph nearly
 * unchanged: the slider moves, the render changes, and nothing looks smoothed.
 */
const SKIN_EPSILON = 4e-3;

/** Run the grade shader. Shared by the graph node and the tone-response probe. */
export function drawGrade(
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
export function buildNodes(): DagNode<PassContext, RenderTarget, Recipe>[] {
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

  /**
   * The displacement field the reshaping acts through.
   *
   * `ingest` is named as an input for one reason: a node can only be switched
   * off if it has something to pass through, and a recipe that is not reshaping
   * anything must not pay for a field of zeros. What the stages downstream get
   * in that case is the ingested frame bound to a sampler they never read,
   * because `uWarped` is zero and the lookup is branched past.
   */
  const warpField: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'warpField',
    inputs: ['ingest'],
    active: isWarping,
    // Held in the source's frame, so neither the render size nor the framing
    // is in here: the same field is correct for the proxy and the export.
    signature: (recipe, ctx) =>
      `warpField:${ctx.face?.key ?? 'none'}:${JSON.stringify(recipe.face.warp)}`,
    evaluate: (ctx, _inputs, recipe) => {
      const face = ctx.face as FaceTextures;
      const [width, height] = fitLongEdge(ctx.source.width, ctx.source.height, WARP_FIELD_EDGE);
      const { points } = warpControlPoints(face.faces, recipe.face.warp);
      const packed = packControlPoints(points);
      const target = ctx.glctx.pool.acquire(width, height);
      ctx.programs.warpField
        .bind()
        .vec4Array('uPoint', packed.point)
        .vec4Array('uDelta', packed.delta)
        .int('uCount', points.length)
        .float('uAspect', face.aspect);
      ctx.glctx.draw(target, width, height);
      return target;
    },
  };

  /**
   * The photograph, moved.
   *
   * Before the skin stage, because the design fixes it there: smoothing a
   * resampled face is smoothing the face that will be in the picture, while
   * resampling a smoothed one stretches the texture the smoothing just decided
   * to keep.
   */
  const warp: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'warp',
    inputs: ['ingest', 'warpField'],
    active: isWarping,
    signature: (_recipe, ctx) =>
      `warp:${ctx.source.generation}:${ctx.width}x${ctx.height}:${ctx.source.fromSrgb}:${ctx.geometryKey}`,
    evaluate: (ctx, [, field]) => {
      const target = ctx.glctx.pool.acquire(ctx.width, ctx.height);
      ctx.programs.warp
        .bind()
        .texture('uSource', ctx.source.texture)
        .texture('uWarp', (field as RenderTarget).texture)
        .int('uWarped', 1)
        .mat3('uGeometry', ctx.geometry)
        .int('uFromSrgb', ctx.source.fromSrgb ? 1 : 0);
      ctx.glctx.draw(target, ctx.width, ctx.height);
      return target;
    },
  };

  /**
   * The guided filter behind the skin stage, as a chain of small passes.
   *
   * Means, deviations from them, coefficients, averaged again: that is the
   * filter, and each step is separable so the cost is linear in the radius
   * rather than square.
   *
   * `faceWideMean` averages the same lightness and chroma over a window several
   * times wider, and it is the means that are averaged rather than the
   * coefficients. That distinction is the whole of it: three things downstream —
   * the blotchiness the skin stage evens out, the surrounding skin that shine is
   * pulled towards, and the lightness an under-eye shadow is lifted to — all
   * want a local average of the picture, and the filter's `b` is not one. It is
   * a local average multiplied by one minus the filter's `a`, so it falls away
   * at every edge the filter is protecting, and anything reading it as a
   * lightness is reading the filter's own decisions back as if they were skin.
   */
  const faceMean: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'faceMean',
    // No graph input: it reads the source photograph, over the working area
    // around the faces. That is what keeps the filter's result the same at every
    // render scale, since nothing about it comes from the framed render.
    inputs: [],
    signature: (_recipe, ctx) =>
      `faceMean:${ctx.source.generation}:${faceFilterSize(ctx).join('x')}:${ctx.face?.key ?? 'none'}`,
    evaluate: (ctx) => {
      const [width, height] = faceFilterSize(ctx);
      const target = ctx.glctx.pool.acquire(width, height);
      ctx.programs.faceMean
        .bind()
        .texture('uSource', ctx.source.texture)
        .int('uFromSrgb', ctx.source.fromSrgb ? 1 : 0)
        .vec4('uRegion', ...regionOf(ctx));
      ctx.glctx.draw(target, width, height);
      return target;
    },
  };

  /** The source again, against the means, as the squared deviation. */
  const faceDeviation: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'faceDeviation',
    inputs: ['faceMeanV'],
    signature: (_recipe, ctx) =>
      `faceDeviation:${ctx.source.generation}:${faceFilterSize(ctx).join('x')}:${ctx.face?.key ?? 'none'}`,
    evaluate: (ctx, [mean]) => {
      const src = mean as RenderTarget;
      const target = ctx.glctx.pool.acquire(src.width, src.height);
      ctx.programs.faceDeviation
        .bind()
        .texture('uSource', ctx.source.texture)
        .texture('uMean', src.texture)
        .int('uFromSrgb', ctx.source.fromSrgb ? 1 : 0)
        .vec4('uRegion', ...regionOf(ctx));
      ctx.glctx.draw(target, src.width, src.height);
      return target;
    },
  };

  const box = (
    id: string,
    input: string,
    axis: 'x' | 'y',
    radiusOf: (recipe: Recipe, ctx: PassContext) => number,
  ): DagNode<PassContext, RenderTarget, Recipe> => ({
    id,
    inputs: [input],
    signature: (recipe, ctx) => `${id}:${radiusOf(recipe, ctx)}`,
    evaluate: (ctx, [source], recipe) => {
      const src = source as RenderTarget;
      const target = ctx.glctx.pool.acquire(src.width, src.height);
      ctx.programs.boxBlur
        .bind()
        .texture('uSource', src.texture)
        .vec2('uStep', axis === 'x' ? 1 / src.width : 0, axis === 'y' ? 1 / src.height : 0)
        .int('uRadius', radiusOf(recipe, ctx));
      ctx.glctx.draw(target, src.width, src.height);
      return target;
    },
  });

  const radius = (recipe: Recipe, ctx: PassContext) => skinRadius(recipe.face, ctx);
  // Three times the filter's own window. Narrower and the reference is not
  // slower than what it is being compared against, which would leave nothing in
  // the difference; much wider and the shading of the face starts arriving in
  // it, and evening that out is what flattens a face into a mask.
  const wideRadius = (recipe: Recipe, ctx: PassContext) =>
    clampRadius(skinRadius(recipe.face, ctx) * 3, 2);
  const subjectBoundary = (recipe: Recipe, ctx: PassContext) => subjectRadius(recipe, ctx);

  const faceCoeffRaw: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'faceCoeffRaw',
    inputs: ['faceMeanV', 'faceDeviationV'],
    signature: () => `faceCoeffRaw:${SKIN_EPSILON}`,
    evaluate: (ctx, [mean, variance]) => {
      const src = mean as RenderTarget;
      const target = ctx.glctx.pool.acquire(src.width, src.height);
      ctx.programs.faceCoeff
        .bind()
        .texture('uMean', src.texture)
        .texture('uVariance', (variance as RenderTarget).texture)
        .float('uEpsilon', SKIN_EPSILON);
      ctx.glctx.draw(target, src.width, src.height);
      return target;
    },
  };

  /**
   * Skin: the smoothing, the colour evening and the shine.
   *
   * Before the grade, because smoothing is about the surface the light fell on
   * and grading is about the light. The other way round, the stage would be
   * smoothing the gradients the grade had just built.
   */
  const skin: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'skin',
    inputs: ['warp', 'faceCoeff', 'faceMeanV', 'faceWideMean', 'warpField'],
    active: (recipe, ctx) => ctx.face !== null && !isSkinNeutral(recipe.face),
    signature: (recipe, ctx) =>
      `skin:${JSON.stringify(skinUniforms(recipe, ctx))}:${isWarping(recipe, ctx)}`,
    evaluate: (ctx, [source, coeff, mean, wide, field], recipe) => {
      const src = source as RenderTarget;
      const face = ctx.face as FaceTextures;
      const uniforms = skinUniforms(recipe, ctx);
      const target = ctx.glctx.pool.acquire(ctx.width, ctx.height);
      ctx.programs.skin
        .bind()
        .vec4('uRegion', ...regionOf(ctx))
        .texture('uSource', src.texture)
        .texture('uCoeff', (coeff as RenderTarget).texture)
        .texture('uMean', (mean as RenderTarget).texture)
        .texture('uWideMean', (wide as RenderTarget).texture)
        .texture('uMask', face.mask.texture)
        .texture('uWarp', (field as RenderTarget).texture)
        .int('uWarped', isWarping(recipe, ctx) ? 1 : 0)
        .mat3('uGeometry', ctx.geometry)
        .float('uSmooth', uniforms.smooth)
        .float('uBlemish', uniforms.blemish)
        .float('uTexture', uniforms.texture)
        .float('uShine', uniforms.shine)
        .float('uTone', uniforms.tone);
      ctx.glctx.draw(target, ctx.width, ctx.height);
      return target;
    },
  };

  /** Parts: the eyes, the teeth, the lips, the cheeks, the shadow under an eye. */
  const parts: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'parts',
    inputs: ['skin', 'faceWideMean', 'warpField'],
    active: (recipe, ctx) => ctx.face !== null && !isPartsNeutral(recipe.face),
    signature: (recipe, ctx) =>
      `parts:${JSON.stringify(partsUniforms(recipe, ctx))}:${isWarping(recipe, ctx)}`,
    evaluate: (ctx, [source, wide, field], recipe) => {
      const src = source as RenderTarget;
      const face = ctx.face as FaceTextures;
      const uniforms = partsUniforms(recipe, ctx);
      const target = ctx.glctx.pool.acquire(ctx.width, ctx.height);
      ctx.programs.parts
        .bind()
        .vec4('uRegion', ...regionOf(ctx))
        .texture('uSource', src.texture)
        .texture('uPolyA', face.polyA)
        .texture('uPolyB', face.polyB)
        .texture('uMask', face.mask.texture)
        .texture('uWideMean', (wide as RenderTarget).texture)
        .texture('uWarp', (field as RenderTarget).texture)
        .int('uWarped', isWarping(recipe, ctx) ? 1 : 0)
        .mat3('uGeometry', ctx.geometry)
        .float('uUndereye', uniforms.undereye)
        .float('uEyes', uniforms.eyes)
        .float('uTeeth', uniforms.teeth)
        .float('uLip', uniforms.lip)
        .float('uLipHue', uniforms.lipHue)
        .float('uCheek', uniforms.cheek)
        .float('uCheekHue', uniforms.cheekHue);
      ctx.glctx.draw(target, ctx.width, ctx.height);
      return target;
    },
  };

  /**
   * The separation, before it is refined: the person, and a guide to snap to.
   *
   * No graph input, for the same reason `faceMean` has none — it reads the
   * source photograph rather than the framed render, so the boundary lands in
   * the same place on the proxy and on the export.
   */
  const subjectRaw: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'subjectRaw',
    inputs: [],
    signature: (_recipe, ctx) =>
      `subjectRaw:${ctx.subject?.key ?? 'none'}:${subjectSize(ctx).join('x')}`,
    evaluate: (ctx) => {
      const subject = ctx.subject as SubjectTextures;
      const [width, height] = subjectSize(ctx);
      const target = ctx.glctx.pool.acquire(width, height);
      ctx.programs.subjectRaw
        .bind()
        .texture('uSegment', subject.segment)
        .texture('uImage', ctx.source.texture);
      ctx.glctx.draw(target, width, height);
      return target;
    },
  };

  /**
   * The guided filter that moves the boundary onto the photograph.
   *
   * The same filter the skin mask is refined by, and the same four programs:
   * what differs is the signal and the working area, not the arithmetic. The
   * segmentation arrives 256 pixels across, so magnified to a frame its edge
   * sits a long way from the shoulder it is meant to follow, and nothing else
   * here knows where hair ends.
   *
   * There is no separate feather afterwards. The radius the refinement is given
   * is also the softness it leaves behind, which makes `edgeRefine` one control
   * over one thing rather than two that have to be balanced against each other.
   */
  const subjectDeviation: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'subjectDeviation',
    inputs: ['subjectRaw', 'subjectMean'],
    signature: (_recipe, ctx) => `subjectDeviation:${subjectSize(ctx).join('x')}`,
    evaluate: (ctx, [raw, mean]) => {
      const src = raw as RenderTarget;
      const target = ctx.glctx.pool.acquire(src.width, src.height);
      ctx.programs.faceMaskDeviation
        .bind()
        .texture('uSource', src.texture)
        .texture('uMean', (mean as RenderTarget).texture);
      ctx.glctx.draw(target, src.width, src.height);
      return target;
    },
  };

  const subjectCoeff: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'subjectCoeff',
    inputs: ['subjectMean', 'subjectDeviationV'],
    signature: () => `subjectCoeff:${MASK_EPSILON}`,
    evaluate: (ctx, [mean, deviation]) => {
      const src = mean as RenderTarget;
      const target = ctx.glctx.pool.acquire(src.width, src.height);
      ctx.programs.faceMaskCoeff
        .bind()
        .texture('uMean', src.texture)
        .texture('uDeviation', (deviation as RenderTarget).texture)
        .float('uEpsilon', MASK_EPSILON);
      ctx.glctx.draw(target, src.width, src.height);
      return target;
    },
  };

  /**
   * The separation itself, in the photograph's own frame.
   *
   * `uRegion` is the whole frame rather than a working area around the faces.
   * The mask shaders take the rectangle as a uniform precisely so that both
   * answers are available: the skin mask needs the faces resolved, and this
   * needs the frame divided.
   */
  const subjectMask: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'subjectMask',
    inputs: ['subjectCoeffV'],
    signature: (_recipe, ctx) => `subjectMask:${subjectSize(ctx).join('x')}`,
    evaluate: (ctx, [coeff]) => {
      const src = coeff as RenderTarget;
      const target = ctx.glctx.pool.acquire(src.width, src.height);
      ctx.programs.faceMaskApply
        .bind()
        .vec4('uRegion', 0, 0, 1, 1)
        .texture('uCoeff', src.texture)
        .texture('uImage', ctx.source.texture);
      ctx.glctx.draw(target, src.width, src.height);
      return target;
    },
  };

  /**
   * Lift the highlights and weight the frame by how much of it is background.
   *
   * At the render size rather than at the convolution's, because the mask is
   * read here and the mask is the one thing in this chain that has to stay
   * sharp: the boundary is where the whole effect is judged.
   */
  const bokehLift: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'bokehLift',
    inputs: ['parts', 'subjectMask', 'warpField'],
    active: isDefocusing,
    signature: (recipe, ctx) =>
      `bokehLift:${ctx.width}x${ctx.height}:${recipe.depth.bokehBloom}:${ctx.geometryKey}:${isWarping(recipe, ctx)}`,
    evaluate: (ctx, [source, mask, field], recipe) => {
      const src = source as RenderTarget;
      const target = ctx.glctx.pool.acquire(ctx.width, ctx.height);
      ctx.programs.bokehLift
        .bind()
        .texture('uSource', src.texture)
        .texture('uSubject', (mask as RenderTarget).texture)
        .texture('uWarp', (field as RenderTarget).texture)
        .int('uWarped', isWarping(recipe, ctx) ? 1 : 0)
        .mat3('uGeometry', ctx.geometry)
        .float('uBloom', recipe.depth.bokehBloom);
      ctx.glctx.draw(target, ctx.width, ctx.height);
      return target;
    },
  };

  /**
   * Down to the size the convolution runs at, halving at a time.
   *
   * One bilinear tap across a reduction of six is a point sample of six texels
   * and it aliases; halving is the one ratio at which a bilinear tap is exactly
   * the average of what it replaced. Doing it in steps is therefore not a
   * refinement, it is the difference between a smooth background and a
   * shimmering one — and it doubles as the prefilter that closes the gaps
   * between the gather's taps.
   */
  const bokehReduce: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'bokehReduce',
    inputs: ['bokehLift'],
    active: isDefocusing,
    signature: (recipe, ctx) => `bokehReduce:${bokehSize(recipe, ctx).join('x')}`,
    evaluate: (ctx, [input], recipe) => {
      const [width, height] = bokehSize(recipe, ctx);
      let current = input as RenderTarget;
      // The first one belongs to the graph; every one after it is ours.
      let owned = false;
      while (current.width > width * 2 && current.height > height * 2) {
        const next = ctx.glctx.pool.acquire(
          Math.max(width, Math.round(current.width / 2)),
          Math.max(height, Math.round(current.height / 2)),
        );
        ctx.programs.copy.bind().texture('uSource', current.texture);
        ctx.glctx.draw(next, next.width, next.height);
        if (owned) ctx.glctx.pool.release(current);
        current = next;
        owned = true;
      }
      const target = ctx.glctx.pool.acquire(width, height);
      ctx.programs.copy.bind().texture('uSource', current.texture);
      ctx.glctx.draw(target, width, height);
      if (owned) ctx.glctx.pool.release(current);
      return target;
    },
  };

  /** The convolution: an aperture-shaped gather over the premultiplied frame. */
  const bokehGather: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'bokehGather',
    inputs: ['bokehReduce'],
    active: isDefocusing,
    signature: (recipe, ctx) =>
      `bokehGather:${bokehRadius(recipe, ctx).join(',')}:${recipe.depth.aperture}:${recipe.depth.catsEye}`,
    evaluate: (ctx, [input], recipe) => {
      const src = input as RenderTarget;
      const target = ctx.glctx.pool.acquire(src.width, src.height);
      ctx.programs.bokehGather
        .bind()
        .texture('uSource', src.texture)
        .vec2('uRadius', ...bokehRadius(recipe, ctx))
        .int('uAperture', apertureIndex(recipe.depth))
        .float('uCatsEye', recipe.depth.catsEye)
        .float('uAspect', src.height / Math.max(src.width, 1));
      ctx.glctx.draw(target, src.width, src.height);
      return target;
    },
  };

  /**
   * Depth: the defocused background put back behind the person.
   *
   * Before the grade, because a lens is in front of the film. Raising the
   * exposure and then defocusing is not the same photograph as defocusing and
   * then raising it, and only the second order is one a camera can produce.
   */
  const bokeh: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'bokeh',
    inputs: ['parts', 'bokehGather', 'subjectMask', 'warpField'],
    active: isDefocusing,
    signature: (recipe, ctx) =>
      `bokeh:${ctx.width}x${ctx.height}:${recipe.depth.bgBrightness}:${recipe.depth.bgSaturation}:${ctx.geometryKey}:${isWarping(recipe, ctx)}`,
    evaluate: (ctx, [source, gathered, mask, field], recipe) => {
      const src = source as RenderTarget;
      const target = ctx.glctx.pool.acquire(ctx.width, ctx.height);
      ctx.programs.bokeh
        .bind()
        .texture('uSource', src.texture)
        .texture('uBokeh', (gathered as RenderTarget).texture)
        .texture('uSubject', (mask as RenderTarget).texture)
        .texture('uWarp', (field as RenderTarget).texture)
        .int('uWarped', isWarping(recipe, ctx) ? 1 : 0)
        .mat3('uGeometry', ctx.geometry)
        .float('uBrightness', recipe.depth.bgBrightness)
        .float('uSaturation', recipe.depth.bgSaturation);
      ctx.glctx.draw(target, ctx.width, ctx.height);
      return target;
    },
  };

  const grade: DagNode<PassContext, RenderTarget, Recipe> = {
    id: 'grade',
    inputs: ['bokeh'],
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

  return [
    ingest,
    warpField,
    warp,
    faceMean,
    box('faceMeanH', 'faceMean', 'x', radius),
    box('faceMeanV', 'faceMeanH', 'y', radius),
    faceDeviation,
    box('faceDeviationH', 'faceDeviation', 'x', radius),
    box('faceDeviationV', 'faceDeviationH', 'y', radius),
    faceCoeffRaw,
    box('faceCoeffH', 'faceCoeffRaw', 'x', radius),
    box('faceCoeff', 'faceCoeffH', 'y', radius),
    box('faceWideMeanH', 'faceMeanV', 'x', wideRadius),
    box('faceWideMean', 'faceWideMeanH', 'y', wideRadius),
    skin,
    parts,
    subjectRaw,
    box('subjectMeanH', 'subjectRaw', 'x', subjectBoundary),
    box('subjectMean', 'subjectMeanH', 'y', subjectBoundary),
    subjectDeviation,
    box('subjectDeviationH', 'subjectDeviation', 'x', subjectBoundary),
    box('subjectDeviationV', 'subjectDeviationH', 'y', subjectBoundary),
    subjectCoeff,
    box('subjectCoeffH', 'subjectCoeff', 'x', subjectBoundary),
    box('subjectCoeffV', 'subjectCoeffH', 'y', subjectBoundary),
    subjectMask,
    bokehLift,
    bokehReduce,
    bokehGather,
    bokeh,
    grade,
    lowSmall,
    lowH,
    low,
  ];
}
