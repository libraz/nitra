/**
 * The types the render layer's three parts agree on.
 *
 * A stage needs them, the device needs them, and the pipeline needs them, so
 * they are held apart from all three rather than in whichever one happened to
 * declare them first. That is what keeps the import graph acyclic: everything
 * here depends on nothing else in the layer.
 */

import type { Mat3 } from '../color/matrix';
import type { FaceRegions } from '../face/geometry';
import type { FaceMaskRegion } from '../face/raster';
import type { GlContext, Program, RenderTarget } from './gl';

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

export interface SourceTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
  fromSrgb: boolean;
  /** Bumped on every new source, so cached results cannot survive a file swap. */
  generation: number;
}

/** The framing a pass is being evaluated under. */
export interface FrameSpec {
  width: number;
  height: number;
  /** Output coordinate back to source coordinate. */
  matrix: Mat3;
  key: string;
}

/**
 * What the face analysis left on the GPU.
 *
 * All of it is in the source image's own frame, so a crop or a rotation does
 * not invalidate any of it: the stages sample these through the same matrix
 * that frames the photo. Which is also why the refined mask is built once per
 * photo rather than per variant — nothing about it depends on the framing or on
 * a slider.
 */
export interface FaceTextures {
  /** The refined, feathered skin mask. Coverage in red. */
  mask: RenderTarget;
  /** Face outline, feature exclusions, lips, mouth interior. */
  polyA: WebGLTexture;
  /** Eye openings, under-eye bands, cheeks. */
  polyB: WebGLTexture;
  /** The widest face's width, in source-image-width units. */
  faceWidth: number;
  faceCount: number;
  /**
   * The outlines and features themselves, which reshaping displaces.
   *
   * The other stages work off the rasterised masks and never need these. A
   * displacement is not a coverage value, though: it is a direction and a
   * distance, and what decides both is where the outline of this face runs.
   */
  faces: readonly FaceRegions[];
  /** Source height over source width, which makes the distances isotropic. */
  aspect: number;
  /** The part of the photo the masks cover, in normalised image coordinates. */
  region: FaceMaskRegion;
  /** Pixel size of the working area, which the filter is sized against. */
  regionPixels: [number, number];
  key: string;
}

/**
 * What the segmentation left on the GPU, face or no face.
 *
 * Held apart from {@link FaceTextures} because it answers a different question
 * and survives a different set of photographs. The skin mask needs an outline
 * and therefore a found face; the division between a person and what is behind
 * them needs neither, and a head turned away from the camera is still somebody
 * to separate from the room.
 */
export interface SubjectTextures {
  /** Face-skin, hair and person confidence, at the model's own 256 pixels. */
  segment: WebGLTexture;
  key: string;
}

export interface PassContext {
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
  face: FaceTextures | null;
  subject: SubjectTextures | null;
}

export interface Programs {
  ingest: Program;
  grade: Program;
  blur: Program;
  copy: Program;
  finish: Program;
  boxBlur: Program;
  faceMean: Program;
  faceDeviation: Program;
  faceCoeff: Program;
  faceMaskRaw: Program;
  faceMaskDeviation: Program;
  faceMaskCoeff: Program;
  faceMaskApply: Program;
  warpField: Program;
  warp: Program;
  skin: Program;
  parts: Program;
  hairRaw: Program;
  hair: Program;
  subjectRaw: Program;
  bokehLift: Program;
  bokehGather: Program;
  bokeh: Program;
  faceTexture: Program;
  faceProbe: Program;
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
  /**
   * How much of the skin's own texture survived, as a fraction.
   *
   * Null when there is no face to measure, or when the face stages are doing
   * nothing — an absent reading and a reading of 1.0 are different statements,
   * and showing the second for the first would put a gauge on a landscape.
   */
  textureRetention: number | null;
}

/**
 * What the skin looks like, for the automatic starting values.
 *
 * Measured off the skin mask rather than off the frame. Every one of these is a
 * question the frame's histogram cannot answer: how bright the person is, how
 * bright everything else is, how uneven their skin is, how much of it is
 * reflecting the light back.
 */
export interface FaceStats {
  faceCount: number;
  /** Fraction of the frame the skin mask covers. */
  coverage: number;
  /** Mean Oklab lightness inside the mask. */
  skinLightness: number;
  /** Mean Oklab lightness of everything outside it. */
  surroundLightness: number;
  /** How much slow variation the skin carries, 0 to 1. */
  unevenness: number;
  /** How much of the skin is reflecting the light source, 0 to 1. */
  specular: number;
}
