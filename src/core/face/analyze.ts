/**
 * The Analyze stage: one run of the models per photo, cached.
 *
 * It sits behind the rest of the face code as the only part that touches a
 * model runtime. Everything downstream — the regions, the coverage bitmaps, the
 * radii — is arithmetic over the result, which is why all of that is testable
 * and this is not.
 *
 * It runs once per photo and never during a drag. Inference on the GPU and the
 * readback it implies would stall the pipeline, and a stall inside a slider is
 * the lag the proxy renderer exists to avoid.
 *
 * The models and their runtime are served from this origin. Nothing about the
 * photo is sent anywhere, and neither is the fact that the app is open.
 */

import { FaceLandmarker, FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { type FaceRegions, faceRegions } from './geometry';
import { type FaceMaskRegion, type MaskBitmap, rasteriseFaces } from './raster';
import {
  SEGMENT_CHANNELS,
  type Segmentation,
  segmentationWeight,
  skinConfidence,
} from './segmentation';

export type { Segmentation };

/** Where `scripts/fetch-models.ts` puts everything. */
const ASSET_BASE = 'models';

/** How many faces are looked for. Beyond this a group photo is a crowd. */
const MAX_FACES = 5;

/** Longest edge the landmarker is given, per region looked at. */
const LANDMARK_EDGE = 1280;

/**
 * The grid of overlapping windows the detector also sweeps.
 *
 * Six windows, which measured at about 150ms all together — affordable inside
 * the budget for opening a photo, and what makes a face that is small in the
 * frame findable at all. See `regionsOf`.
 */
const TILE_COLS = 3;
const TILE_ROWS = 2;
const TILE_OVERLAP = 0.25;

/** Longest edge of one window. Enough for the mesh, small enough to be quick. */
const TILE_EDGE = 768;

/**
 * Longest edge the segmenter is given.
 *
 * Its model works at 256×256, so anything larger is resampled twice and the
 * mask comes back at the size it was handed — which would be megabytes of
 * float per class for no more detail. The boundary is recovered afterwards by
 * joint upsampling against the photo itself.
 */
const SEGMENT_EDGE = 256;

/**
 * Class indices of the segmentation model.
 *
 * The skin mask is built from the face's own skin and has hair taken out of
 * it. Body skin is deliberately not part of that: an arm is skin, and smoothing
 * it because the face is being smoothed is not what was asked for.
 *
 * The background class is read instead of adding up the other five. It is one
 * fetch rather than five, and the classes are confidences that sum to one, so
 * the complement of the background *is* the person — including the clothes and
 * whatever they are carrying, which is what has to move out of focus together.
 */
const CLASS_BACKGROUND = 0;
const CLASS_HAIR = 1;
const CLASS_FACE_SKIN = 3;

export interface FaceAnalysis {
  /** Bumped per run, so a cached mask cannot outlive the photo it describes. */
  revision: number;
  faces: FaceRegions[];
  /** Coverage bitmaps over {@link region}. See `FACE_MASK_CHANNELS`. */
  masks: readonly [MaskBitmap, MaskBitmap];
  /**
   * The part of the photo the masks cover, in normalised image coordinates.
   *
   * The faces and a margin, not the whole frame: a mask spread over a large
   * photograph has a few dozen pixels of face in it, and that is visible on the
   * result. See `faceRegion`.
   */
  region: FaceMaskRegion;
  segmentation: Segmentation;
  /**
   * How much the segmentation should be intersected with the outlines, 0 to 1.
   *
   * Zero where the two disagree, which means the outlines are used on their
   * own. See `segmentation.ts` for why that is the right way round.
   */
  segmentationWeight: number;
  /** The largest face's width, in image-width units. */
  faceWidth: number;
  sourceWidth: number;
  sourceHeight: number;
}

export class FaceAnalysisError extends Error {}

interface Models {
  landmarker: FaceLandmarker;
  segmenter: ImageSegmenter;
}

let models: Promise<Models> | null = null;
let revision = 0;

/**
 * Load the models, once per session.
 *
 * Kept as the pending promise rather than the resolved value so two photos
 * opened in quick succession wait on one load instead of starting two.
 */
function loadModels(): Promise<Models> {
  if (models) return models;
  models = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(`${ASSET_BASE}/wasm`);
    const [landmarker, segmenter] = await Promise.all([
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${ASSET_BASE}/face_landmarker.task`,
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        numFaces: MAX_FACES,
      }),
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${ASSET_BASE}/selfie_multiclass_256x256.tflite`,
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }),
    ]);
    return { landmarker, segmenter };
  })().catch((cause) => {
    // A failed load must not be remembered as a load: the next photo should try
    // again rather than inherit a rejected promise for the rest of the session.
    models = null;
    throw new FaceAnalysisError(
      cause instanceof Error ? cause.message : 'the face models could not be loaded',
    );
  });
  return models;
}

function fitWithin(width: number, height: number, longEdge: number): [number, number] {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

type Canvas2D = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): Canvas2D {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  return el;
}

/**
 * The photo on a canvas, at its own size, once.
 *
 * Every pass below draws out of this one rather than putting the pixels up
 * again: a twelve-megapixel `putImageData` per tile would cost more than the
 * inference it is feeding.
 *
 * Held as sRGB rather than the working space on purpose. The models were
 * trained on ordinary photographs, and handing one wide-gamut values it reads
 * as sRGB would shift every colour it keys on, skin above all.
 */
function toCanvas(source: ImageData): Canvas2D {
  const full = makeCanvas(source.width, source.height);
  const ctx = full.getContext('2d', { colorSpace: 'srgb' }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new FaceAnalysisError('a 2D canvas is not available');
  ctx.putImageData(source, 0, 0);
  return full;
}

/** A rectangle of the photo, in source pixels. */
interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Draw one region of the photo into a canvas no larger than `longEdge`. */
function excerpt(full: Canvas2D, region: Region, longEdge: number): Canvas2D {
  const [width, height] = fitWithin(region.width, region.height, longEdge);
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new FaceAnalysisError('a 2D canvas is not available');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    full as CanvasImageSource,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    width,
    height,
  );
  return canvas;
}

/**
 * The regions the detector is run over.
 *
 * The whole frame first, and then a coarse grid of overlapping windows.
 *
 * The grid is not an optimisation, it is the difference between working and not
 * working on an ordinary photograph. The detector resizes whatever it is given
 * to a couple of hundred pixels, so what decides whether a face is found is how
 * large it is *as a fraction of the frame* — not how many pixels it has. A
 * portrait is found at any resolution and a person standing in a room is found
 * at none of them: measured on a 4240-pixel frame, a face six per cent of its
 * width was missed at every size from 640 to full, and found in a moment once
 * the frame was looked at in six pieces.
 *
 * The windows overlap so a face is not cut in half by a boundary, which does
 * mean the same face can be found twice; they are merged afterwards.
 */
function regionsOf(width: number, height: number): Region[] {
  const windows: Region[] = [{ x: 0, y: 0, width, height }];
  const stepX = width / (TILE_COLS - (TILE_COLS - 1) * TILE_OVERLAP);
  const stepY = height / (TILE_ROWS - (TILE_ROWS - 1) * TILE_OVERLAP);
  for (let row = 0; row < TILE_ROWS; row++) {
    for (let col = 0; col < TILE_COLS; col++) {
      windows.push({
        x: col * stepX * (1 - TILE_OVERLAP),
        y: row * stepY * (1 - TILE_OVERLAP),
        width: stepX,
        height: stepY,
      });
    }
  }
  return windows;
}

/**
 * Two detections of the same face, merged down to the better one.
 *
 * Better means larger in the window it was found in: the mesh is fitted to a
 * crop of whatever it was handed, so the detection with more of the frame given
 * over to the face is the one with more pixels behind every landmark.
 */
function merge(found: FaceRegions[]): FaceRegions[] {
  const kept: FaceRegions[] = [];
  for (const face of [...found].sort((a, b) => b.width - a.width)) {
    const duplicate = kept.some((other) => {
      const apart = Math.hypot(face.centre.x - other.centre.x, face.centre.y - other.centre.y);
      return apart < Math.min(face.width, other.width) * 0.5;
    });
    if (!duplicate) kept.push(face);
  }
  return kept;
}

/** Pack the classes the masks are built from into one bitmap. */
function packSegmentation(
  faceSkin: Float32Array,
  hair: Float32Array,
  background: Float32Array,
  width: number,
  height: number,
): Segmentation {
  const data = new Uint8ClampedArray(width * height * SEGMENT_CHANNELS);
  for (let i = 0; i < width * height; i++) {
    data[i * SEGMENT_CHANNELS] = (faceSkin[i] as number) * 255;
    data[i * SEGMENT_CHANNELS + 1] = (hair[i] as number) * 255;
    data[i * SEGMENT_CHANNELS + 2] = (1 - (background[i] as number)) * 255;
  }
  return { width, height, data };
}

/**
 * Find the faces in a photo and build everything keyed to them.
 *
 * @param image The photo as it arrived, upright and at full size.
 */
export async function analyzeFace(image: ImageData): Promise<FaceAnalysis> {
  const { landmarker, segmenter } = await loadModels();
  const aspect = image.height / image.width;

  const full = toCanvas(image);
  const found: FaceRegions[] = [];
  for (const [index, region] of regionsOf(image.width, image.height).entries()) {
    const whole = index === 0;
    const canvas = excerpt(full, region, whole ? LANDMARK_EDGE : TILE_EDGE);
    const detection = landmarker.detect(canvas as HTMLCanvasElement);
    for (const landmarks of detection.faceLandmarks ?? []) {
      // The landmarks are normalised against the window they were found in, so
      // they are put back into the frame's own coordinates before anything
      // downstream sees them.
      found.push(
        faceRegions(
          landmarks.map((point) => ({
            x: (region.x + point.x * region.width) / image.width,
            y: (region.y + point.y * region.height) / image.height,
          })),
          aspect,
        ),
      );
    }
  }
  const faces = merge(found);

  const segmentInput = excerpt(
    full,
    { x: 0, y: 0, width: image.width, height: image.height },
    SEGMENT_EDGE,
  );
  const result = segmenter.segment(segmentInput as HTMLCanvasElement);
  const confidence = result.confidenceMasks;
  const faceSkin = confidence?.[CLASS_FACE_SKIN];
  const hair = confidence?.[CLASS_HAIR];
  const background = confidence?.[CLASS_BACKGROUND];
  if (!faceSkin || !hair || !background) {
    result.close();
    throw new FaceAnalysisError('the segmentation model returned no confidence masks');
  }
  const segmentation = packSegmentation(
    faceSkin.getAsFloat32Array(),
    hair.getAsFloat32Array(),
    background.getAsFloat32Array(),
    faceSkin.width,
    faceSkin.height,
  );
  result.close();

  const rasterised = rasteriseFaces(faces, image.width, image.height, aspect);

  revision += 1;
  return {
    revision,
    faces,
    masks: rasterised.maps,
    region: rasterised.region,
    segmentation,
    segmentationWeight: segmentationWeight(skinConfidence(segmentation, faces, aspect)),
    faceWidth: faces.reduce((widest, face) => Math.max(widest, face.width), 0),
    sourceWidth: image.width,
    sourceHeight: image.height,
  };
}
