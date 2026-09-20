/**
 * Editor state.
 *
 * The recipe is the only description of the edit; the canvas is a view of it.
 * Nothing here holds a modified copy of the image, which is what makes every
 * step reversible and the history unbounded.
 */

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AutoNote, suggestGrade } from '../core/analysis/auto';
import { MAT3_IDENTITY, type Mat3 } from '../core/color/matrix';
import { analyzeFace, type FaceAnalysis } from '../core/face/analyze';
import { aspectByKey, resolveAspect } from '../core/geometry/aspects';
import { cropRatioForTiles, type ExportPlan, planExport } from '../core/geometry/tiles';
import {
  clampCrop,
  fitCropToAspect,
  flipFieldFor,
  frameSize,
  geometrySignature,
  outputToSource,
} from '../core/geometry/transform';
import { decodeSourceFile, type SourceImage } from '../core/io/decode';
import { exportImage } from '../core/io/export';
import {
  applyFaceStrength,
  applyStrength,
  isFaceStrengthExempt,
  LOOKS,
  lookByKey,
  REFERENCE_STRENGTH,
} from '../core/recipe/presets';
import {
  type DepthParams,
  type FaceParams,
  type GeometryParams,
  type GlobalParams,
  HEAL_LIMIT,
  type MetadataParams,
  neutralRecipe,
  neutralTextLayer,
  paramDef,
  type Recipe,
  type RestoreParams,
  type TextLayer,
} from '../core/recipe/schema';
import {
  Pipeline,
  type RenderStats,
  type RestoreReference,
  type RestoreReport,
} from '../core/render/pipeline';
import { RenderScheduler } from '../core/render/scheduler';
import { fontsReady, loadFontFile } from '../core/text/fonts';
import { type MessageKey, type Translate, useI18n } from '../i18n';
import { writeParam } from './params';

/** Longest edge of a finish thumbnail. */
const THUMBNAIL_EDGE = 220;

/** The panels the tool rail switches between. */
export type Tool =
  | 'adjust'
  | 'restore'
  | 'heal'
  | 'crop'
  | 'text'
  | 'tiles'
  | 'metadata'
  | 'export';

/** The photograph the faces are restored from, as the panel needs to show it. */
export interface ReferenceState {
  fileName: string;
  width: number;
  height: number;
  /** Faces found in it. Zero is a reference nothing can be taken from. */
  faces: number;
}

/** A change to the metadata block, one group at a time. */
export interface MetadataPatch {
  mode?: MetadataParams['mode'];
  gps?: Partial<MetadataParams['gps']>;
  capture?: Partial<MetadataParams['capture']>;
  credit?: Partial<MetadataParams['credit']>;
  software?: boolean;
}

export type CropRect = GeometryParams['crop'];

/** Parameters the strength dial leaves alone, mirrored for manual edits. */
const STRENGTH_EXEMPT = new Set<string>([
  'global.exposure',
  'global.highlights',
  'global.shadows',
  'global.whites',
  'global.blacks',
  'global.temperature',
  'global.tint',
  'global.skinHueProtect',
]);

/**
 * Where the face analysis has got to.
 *
 * `none` and `failed` are deliberately different states. One is a fact about
 * the photograph and the other is a fact about this session, and the panel says
 * which: a landscape needs no explanation, while models that would not load are
 * something to retry.
 */
export type FaceState = 'idle' | 'analysing' | 'found' | 'none' | 'failed';

export interface EditorToast {
  id: number;
  body: string;
  tone: 'normal' | 'alert';
}

export interface Editor {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
  recipe: Recipe;
  source: SourceImage | null;
  fatal: string | null;
  tool: Tool;
  mode: 'simple' | 'detail';
  look: string;
  strength: number;
  comparing: boolean;
  exporting: boolean;
  stats: RenderStats | null;
  faceState: FaceState;
  /** How many faces the analysis found. Zero until it has. */
  faceCount: number;
  /** The reference photograph, once one has been opened. */
  reference: ReferenceState | null;
  /** True while the reference is being decoded and analysed. */
  referenceBusy: boolean;
  /**
   * What the last restore found, refreshed with the settled render.
   *
   * Null until one has run, which is also what it is whenever the stage is off:
   * the panel says nothing about a restore that did not happen.
   */
  restoreReport: RestoreReport | null;
  toneResponse: Uint8Array | null;
  thumbnails: ReadonlyMap<string, ImageData>;
  scale: 'proxy' | 'full';
  previewSize: string | null;
  workingSpace: string;
  toast: EditorToast | null;
  /** What the current recipe would produce, recomputed as the framing changes. */
  plan: ExportPlan | null;
  /** Shape of the straightened frame the crop is dragged inside. */
  frameAspect: number;
  /**
   * Output coordinate back to source coordinate, both normalised.
   *
   * What the heal overlay places spots through. The spots are the photograph's
   * own coordinates and the overlay sits on the cropped frame, so somebody has
   * to map between them; this is the renderer's own matrix rather than a second
   * copy of the framing maths.
   */
  toSource: Mat3;
  /** Radius the next spot gets, as a fraction of the image width. */
  healRadius: number;
  selectedText: string | null;
  /** Bumped when a supplied typeface finishes loading. */
  fontRevision: number;
  setTool: (tool: Tool) => void;
  setMode: (mode: 'simple' | 'detail') => void;
  setComparing: (on: boolean) => void;
  setParam: (path: string, value: number) => void;
  setDepth: (patch: Partial<DepthParams>) => void;
  setOutput: (patch: Partial<Recipe['output']>) => void;
  setMetadata: (patch: MetadataPatch) => void;
  setLook: (key: string) => void;
  setStrength: (value: number) => void;
  setGeometry: (patch: Partial<GeometryParams>) => void;
  setCrop: (crop: CropRect) => void;
  setAspect: (key: string) => void;
  rotate: (quarterTurns: number) => void;
  flip: (axis: 'h' | 'v') => void;
  resetFraming: () => void;
  setTiles: (patch: Partial<Recipe['tiles']>) => void;
  matchCropToTiles: (tileRatio: number) => void;
  setRestore: (patch: Partial<RestoreParams>) => void;
  loadReference: (file: File) => void;
  clearReference: () => void;
  setHealRadius: (value: number) => void;
  addHealSpot: (x: number, y: number) => void;
  removeHealSpot: (index: number) => void;
  clearHeal: () => void;
  addText: () => void;
  updateText: (id: string, patch: Partial<TextLayer>) => void;
  removeText: (id: string) => void;
  selectText: (id: string | null) => void;
  loadFont: (file: File) => void;
  openFiles: (files: FileList) => void;
  runAuto: () => void;
  retryFaceAnalysis: () => void;
  runExport: () => void;
}

/** Render one measurement note in the active language. */
function formatNote(note: AutoNote, t: Translate): string {
  switch (note.kind) {
    case 'exposure':
      return t('auto.exposure', {
        stops: `${note.stops >= 0 ? '+' : ''}${note.stops.toFixed(1)}`,
      });
    case 'highlightClip':
      return t('auto.highlightClip', { percent: note.percent.toFixed(1) });
    case 'shadowClip':
      return t('auto.shadowClip', { percent: note.percent.toFixed(1) });
    case 'blackPoint':
      return t('auto.blackPoint');
    case 'whitePoint':
      return t('auto.whitePoint');
    case 'balanced':
      return t('auto.balanced');
    case 'scene':
      return t('auto.scene');
    case 'faces':
      return t('auto.faces', { count: note.count });
    case 'backlit':
      return t('auto.backlit');
    case 'spotlit':
      return t('auto.spotlit');
    case 'uneven':
      return t('auto.uneven', { percent: note.percent.toFixed(0) });
    case 'shine':
      return t('auto.shine', { percent: note.percent.toFixed(0) });
  }
}

/**
 * The photo as the models want it.
 *
 * A view over the bytes the decoder already produced rather than a copy: the
 * analysis resamples it anyway, and copying a twelve-megapixel photo to hand it
 * over would be fifty megabytes for nothing.
 */
function asImageData(image: SourceImage): ImageData {
  // Re-wrapped rather than copied. An ImageData insists on a plain ArrayBuffer
  // and the decoded pixels are typed as either kind of buffer, so the view is
  // rebuilt over the same bytes to say which one it is.
  const pixels = new Uint8ClampedArray(
    image.data.buffer as ArrayBuffer,
    image.data.byteOffset,
    image.data.byteLength,
  );
  return new ImageData(pixels, image.width, image.height, { colorSpace: image.space });
}

function newLayerId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function useEditor(): Editor {
  const { t } = useI18n();
  // Read through a ref where something outside React reaches for a message: the
  // GL context is built once, and naming `t` as a dependency of the effect that
  // builds it would tear the context down to change the language.
  const translateRef = useRef(t);
  translateRef.current = t;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pipelineRef = useRef<Pipeline | null>(null);
  const schedulerRef = useRef<RenderScheduler | null>(null);

  const [recipe, setRecipe] = useState<Recipe>(() => neutralRecipe());
  const recipeRef = useRef(recipe);
  recipeRef.current = recipe;

  /** The finish before the strength dial stretched it. */
  const baselineRef = useRef<Partial<GlobalParams>>({});
  const baselineFaceRef = useRef<Partial<FaceParams>>({});

  /**
   * The last analysis, kept so a remount does not mean running the models again.
   *
   * The pipeline's copy went away with the GPU context; this one is the photo's
   * geometry, which has not changed.
   */
  const analysisRef = useRef<FaceAnalysis | null>(null);

  /**
   * The reference photograph, for the same reason the analysis is kept.
   *
   * Its pixels and its outlines are what the restore works from, and neither is
   * in the recipe. A remount would otherwise leave a recipe naming a reference
   * the renderer no longer holds, which renders as the generated face coming
   * back — exactly the failure the stage exists to undo.
   */
  const referenceRef = useRef<RestoreReference | null>(null);

  const [source, setSource] = useState<SourceImage | null>(null);
  const sourceRef = useRef<SourceImage | null>(null);
  sourceRef.current = source;

  const [fatal, setFatal] = useState<string | null>(null);
  const [tool, setToolState] = useState<Tool>('adjust');
  const [mode, setMode] = useState<'simple' | 'detail'>('simple');
  const [look, setLookState] = useState<string>('none');
  const [strength, setStrengthState] = useState(REFERENCE_STRENGTH);
  const [comparing, setComparingState] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [stats, setStats] = useState<RenderStats | null>(null);
  const [faceState, setFaceState] = useState<FaceState>('idle');
  const [faceCount, setFaceCount] = useState(0);
  const [reference, setReferenceState] = useState<ReferenceState | null>(null);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [restoreReport, setRestoreReport] = useState<RestoreReport | null>(null);
  const [toneResponse, setToneResponse] = useState<Uint8Array | null>(null);
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<string, ImageData>>(new Map());
  const [scale, setScale] = useState<'proxy' | 'full'>('proxy');
  const [previewSize, setPreviewSize] = useState<string | null>(null);
  const [workingSpace, setWorkingSpace] = useState('linear P3 / f16');
  // The brush size is not part of the edit: it is the size the next spot gets,
  // and each spot carries the size it was placed at.
  const [healRadius, setHealRadius] = useState(() => paramDef('heal.r').neutral);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const selectedTextRef = useRef<string | null>(null);
  selectedTextRef.current = selectedText;
  const [fontRevision, setFontRevision] = useState(0);
  const [toast, setToast] = useState<EditorToast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((body: string, tone: 'normal' | 'alert' = 'normal') => {
    setToast({ id: Date.now(), body, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }, []);

  // The pipeline owns GPU resources, so it is created once against the canvas
  // and torn down with it rather than rebuilt on every render.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let pipeline: Pipeline;
    try {
      pipeline = new Pipeline(canvas, () => {
        const box = viewportRef.current?.getBoundingClientRect();
        return { width: box?.width ?? 0, height: box?.height ?? 0 };
      });
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
      return;
    }
    pipelineRef.current = pipeline;
    setWorkingSpace(pipeline.wideGamut ? 'linear P3 / f16' : 'linear sRGB / f16');

    const scheduler = new RenderScheduler(pipeline, {
      recipe: () => recipeRef.current,
      stats: (next) => {
        setStats(next);
        setToneResponse(pipeline.toneResponse(recipeRef.current));
        // The restore runs on the way to this render and nowhere else, so this
        // is the moment its measurement exists to be read.
        setRestoreReport(pipeline.lastRestore);
      },
      scaleChanged: (next) => {
        setScale(next);
        const [width, height] = pipeline.resolutionFor(recipeRef.current, next);
        setPreviewSize(`${width}×${height}`);
      },
      // The spots stay in the picture rather than being reported as gone, and
      // the module's own message names what it could not fetch.
      healFailed: (error) => {
        const detail = error instanceof Error ? ` — ${error.message}` : '';
        notify(`${translateRef.current('toast.healFailed')}${detail}`, 'alert');
      },
    });
    schedulerRef.current = scheduler;

    // A remount arrives with the source already decoded; the GPU copy went away
    // with the previous context, so it is uploaded again rather than asking the
    // user to reopen the file.
    if (sourceRef.current) {
      pipeline.setSource(sourceRef.current);
      pipeline.setFaceAnalysis(analysisRef.current);
      pipeline.setReference(referenceRef.current);
      scheduler.markDirty();
    }

    const onResize = () => scheduler.refresh();
    window.addEventListener('resize', onResize);
    // Type drawn before its face has loaded is type drawn in the fallback, and
    // the fallback is what would end up in the export.
    void fontsReady().then(() => scheduler.refresh());

    return () => {
      window.removeEventListener('resize', onResize);
      scheduler.dispose();
      pipeline.dispose();
      schedulerRef.current = null;
      pipelineRef.current = null;
    };
    // `notify` holds no state of its own and keeps its identity for the life of
    // the editor, so naming it here does not put the GL context on a leash.
  }, [notify]);

  const commit = useCallback((next: Recipe) => {
    recipeRef.current = next;
    setRecipe(next);
    if (sourceRef.current) schedulerRef.current?.markDirty();
  }, []);

  // The crop is placed over the parts of the photo it is about to throw away, so
  // the whole frame has to stay on screen for as long as the tool is open.
  const setTool = useCallback((next: Tool) => {
    setToolState(next);
    schedulerRef.current?.setFullFrame(next === 'crop');
  }, []);

  const setComparing = useCallback((on: boolean) => {
    setComparingState(on);
    schedulerRef.current?.setShowOriginal(on);
  }, []);

  const setParam = useCallback(
    (path: string, value: number) => {
      const next = writeParam(recipeRef.current, path, value);
      // Keep the strength dial meaningful after a manual edit by recording the
      // value as it would be at the reference strength.
      const factor = Math.max(0.02, strength / REFERENCE_STRENGTH);
      if (path.startsWith('global.') && !path.startsWith('global.grain')) {
        const key = path.slice('global.'.length);
        if (!key.includes('.')) {
          Object.assign(baselineRef.current, {
            [key]: STRENGTH_EXEMPT.has(path) ? value : value / factor,
          });
        }
      }
      if (path.startsWith('face.')) {
        const key = path.slice('face.'.length);
        if (!key.includes('.')) {
          Object.assign(baselineFaceRef.current, {
            [key]: isFaceStrengthExempt(key) ? value : value / factor,
          });
        }
      }
      setLookState('custom');
      commit(next);
    },
    [commit, strength],
  );

  const setDepth = useCallback(
    (patch: Partial<DepthParams>) => {
      commit({ ...recipeRef.current, depth: { ...recipeRef.current.depth, ...patch } });
    },
    [commit],
  );

  const setOutput = useCallback(
    (patch: Partial<Recipe['output']>) => {
      commit({ ...recipeRef.current, output: { ...recipeRef.current.output, ...patch } });
    },
    [commit],
  );

  /**
   * Change one group of the metadata block.
   *
   * Merged group by group rather than replaced, so switching a block off leaves
   * the values in it: turning the location back on should not mean typing the
   * coordinates again.
   */
  const setMetadata = useCallback(
    (patch: MetadataPatch) => {
      const current = recipeRef.current;
      const metadata = current.output.metadata;
      const next: MetadataParams = {
        mode: patch.mode ?? metadata.mode,
        gps: { ...metadata.gps, ...patch.gps },
        capture: { ...metadata.capture, ...patch.capture },
        credit: { ...metadata.credit, ...patch.credit },
        software: patch.software ?? metadata.software,
      };
      commit({ ...current, output: { ...current.output, metadata: next } });

      if (patch.mode && patch.mode !== metadata.mode) {
        if (patch.mode === 'strip') notify(t('toast.metadataOn'));
        else if (patch.mode === 'keep') notify(t('toast.metadataOff'), 'alert');
        else notify(t('toast.metadataCustom'), 'alert');
      }
    },
    [commit, notify, t],
  );

  /**
   * Apply a framing change and put the crop back where it belongs.
   *
   * A rotation swaps the frame's shape, so a crop locked to 4:5 stops being 4:5
   * the instant the photo turns. Refitting here rather than in the panel means
   * every route into a framing change — a button, a slider, a drag — ends with a
   * rectangle that still honours the lock and still fits inside the frame.
   */
  const setGeometry = useCallback(
    (patch: Partial<GeometryParams>) => {
      const current = recipeRef.current;
      const image = sourceRef.current;
      const geometry: GeometryParams = { ...current.geometry, ...patch };
      let crop = clampCrop(patch.crop ?? geometry.crop);

      if (image) {
        const [w, h] = frameSize(image.width, image.height, geometry);
        const ratio = resolveAspect(geometry.aspect, w / h);
        if (ratio !== null) crop = fitCropToAspect(crop, ratio, w / h);
      }

      commit({ ...current, geometry: { ...geometry, crop } });
    },
    [commit],
  );

  const setCrop = useCallback((crop: CropRect) => setGeometry({ crop }), [setGeometry]);

  const setAspect = useCallback(
    (key: string) => {
      const preset = aspectByKey(key);
      setGeometry({ aspect: key });
      // A service preset carries the size that service publishes at, so picking
      // one sets both halves of the decision rather than leaving the size to be
      // discovered in the export panel later.
      if (preset && preset.longEdge > 0) {
        const current = recipeRef.current;
        recipeRef.current = {
          ...current,
          output: { ...current.output, longEdge: preset.longEdge },
        };
        setRecipe(recipeRef.current);
      }
      if (preset) notify(t('toast.aspectApplied', { name: t(`aspect.${key}` as MessageKey) }));
    },
    [notify, setGeometry, t],
  );

  const rotate = useCallback(
    (quarterTurns: number) => {
      const current = recipeRef.current.geometry.quarterTurns;
      setGeometry({ quarterTurns: (((current + quarterTurns) % 4) + 4) % 4 });
    },
    [setGeometry],
  );

  const flip = useCallback(
    (axis: 'h' | 'v') => {
      const geometry = recipeRef.current.geometry;
      const field = flipFieldFor(geometry.quarterTurns, axis);
      setGeometry({ [field]: !geometry[field] });
    },
    [setGeometry],
  );

  const resetFraming = useCallback(() => {
    const fresh = neutralRecipe();
    commit({ ...recipeRef.current, geometry: fresh.geometry });
    notify(t('toast.framingReset'));
  }, [commit, notify, t]);

  const setTiles = useCallback(
    (patch: Partial<Recipe['tiles']>) => {
      const current = recipeRef.current;
      commit({ ...current, tiles: { ...current.tiles, ...patch } });
    },
    [commit],
  );

  /**
   * Shape the crop so every tile of the current grid comes out at `tileRatio`.
   *
   * The shape of a tile is the caller's to choose because it is a property of
   * where the grid is going, not of the photo: a profile grid that previews
   * posts at 3:4 needs 3:4 tiles, and the same picture cut into squares for a
   * square grid is a different crop of the same photo.
   */
  const matchCropToTiles = useCallback(
    (tileRatio: number) => {
      const image = sourceRef.current;
      if (!image) return;
      const current = recipeRef.current;
      const [w, h] = frameSize(image.width, image.height, current.geometry);
      const crop = fitCropToAspect(
        current.geometry.crop,
        cropRatioForTiles(tileRatio, current.tiles.cols, current.tiles.rows),
        w / h,
      );
      commit({ ...current, geometry: { ...current.geometry, aspect: 'free', crop } });
    },
    [commit],
  );

  const addText = useCallback(() => {
    const current = recipeRef.current;
    const layer = neutralTextLayer(newLayerId());
    layer.content = t('text.newContent');
    setSelectedText(layer.id);
    commit({ ...current, text: [...current.text, layer] });
  }, [commit, t]);

  const updateText = useCallback(
    (id: string, patch: Partial<TextLayer>) => {
      const current = recipeRef.current;
      commit({
        ...current,
        text: current.text.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)),
      });
    },
    [commit],
  );

  const removeText = useCallback(
    (id: string) => {
      const current = recipeRef.current;
      setSelectedText((selected) => (selected === id ? null : selected));
      commit({ ...current, text: current.text.filter((layer) => layer.id !== id) });
    },
    [commit],
  );

  const selectText = useCallback((id: string | null) => setSelectedText(id), []);

  /**
   * Fill a blemish at a point on the photograph.
   *
   * The coordinates are the source's, not the crop's, and the caller has already
   * put them there — a spot is a mark on the photograph, so it has to survive
   * the frame being tightened around it.
   *
   * The size comes from the brush rather than from the recipe, and is written
   * into the spot: a spot placed at one size keeps it, which is what lets a
   * large mark and a small one sit next to each other.
   */
  const addHealSpot = useCallback(
    (x: number, y: number) => {
      const current = recipeRef.current;
      if (current.heal.length >= HEAL_LIMIT) return;
      commit({ ...current, heal: [...current.heal, { x, y, r: healRadius }] });
    },
    [commit, healRadius],
  );

  const removeHealSpot = useCallback(
    (index: number) => {
      const current = recipeRef.current;
      commit({ ...current, heal: current.heal.filter((_, at) => at !== index) });
    },
    [commit],
  );

  const clearHeal = useCallback(() => {
    commit({ ...recipeRef.current, heal: [] });
  }, [commit]);

  const setRestore = useCallback(
    (patch: Partial<RestoreParams>) => {
      const current = recipeRef.current;
      commit({ ...current, restore: { ...current.restore, ...patch } });
    },
    [commit],
  );

  /**
   * Open the photograph the faces are to be taken back from.
   *
   * Analysed on arrival, because the outlines are what the fit is made of and
   * there is nothing to defer: unlike the frame's own analysis, which the whole
   * app is usable without, this one is the feature. A reference with no face in
   * it is loaded anyway and reported as having none — that is a fact about the
   * file the panel can state, and it is different from the models failing.
   *
   * Naming the file in the recipe is the last step, so the stage cannot switch
   * itself on against a reference that did not finish arriving.
   */
  const loadReference = useCallback(
    (file: File) => {
      setReferenceBusy(true);
      void (async () => {
        try {
          const image = await decodeSourceFile(file, file.name);
          const analysis = await analyzeFace(asImageData(image));
          const next: RestoreReference = {
            image: {
              data: image.data,
              width: image.width,
              height: image.height,
              space: image.space,
            },
            faces: analysis.faces,
            fileName: image.fileName,
          };
          referenceRef.current = next;
          pipelineRef.current?.setReference(next);
          setReferenceState({
            fileName: image.fileName,
            width: image.width,
            height: image.height,
            faces: analysis.faces.length,
          });
          setRestore({ reference: image.fileName });
          notify(
            analysis.faces.length > 0
              ? t('restore.toastLoaded', {
                  name: image.fileName,
                  count: analysis.faces.length,
                })
              : t('restore.toastNoFace', { name: image.fileName }),
            analysis.faces.length > 0 ? 'normal' : 'alert',
          );
        } catch (err) {
          const detail = err instanceof Error ? ` — ${err.message}` : '';
          notify(`${t('restore.toastFailed')}${detail}`, 'alert');
        } finally {
          setReferenceBusy(false);
        }
      })();
    },
    [notify, setRestore, t],
  );

  const clearReference = useCallback(() => {
    referenceRef.current = null;
    pipelineRef.current?.setReference(null);
    setReferenceState(null);
    setRestoreReport(null);
    setRestore({ reference: '' });
  }, [setRestore]);

  /**
   * Register a typeface from the user's own machine and set it on the caption.
   *
   * The face is picked up straight away because that is the point of loading it,
   * and the revision counter is what makes the picker and the coverage check
   * notice: the catalogue lives outside React, so nothing else would tell them.
   */
  const loadFont = useCallback(
    (file: File) => {
      void (async () => {
        try {
          const font = await loadFontFile(file);
          setFontRevision((n) => n + 1);
          const id = selectedTextRef.current ?? recipeRef.current.text.at(-1)?.id;
          if (id) updateText(id, { font: font.key });
          schedulerRef.current?.refresh();
          notify(t('toast.fontLoaded', { name: font.label }));
        } catch (err) {
          const detail = err instanceof Error ? ` — ${err.message}` : '';
          notify(`${t('toast.fontFailed')}${detail}`, 'alert');
        }
      })();
    },
    [notify, t, updateText],
  );

  /**
   * Put a finish on, at a strength.
   *
   * Both halves of it, because a finish is one thing: what it does to the light
   * and what it does to the skin are written together and are turned down
   * together. The face half is applied whether or not there is a face — the
   * renderer is what decides there is nothing to apply it to, and keeping the
   * values in the recipe is what lets the same edit open correctly on a photo
   * where there is.
   */
  const applyLook = useCallback(
    (base: Partial<GlobalParams>, face: Partial<FaceParams>, nextStrength: number) => {
      const fresh = neutralRecipe();
      commit({
        ...recipeRef.current,
        global: { ...fresh.global, ...applyStrength(base, nextStrength) },
        face: { ...fresh.face, ...applyFaceStrength(face, nextStrength) },
      });
    },
    [commit],
  );

  const setLook = useCallback(
    (key: string) => {
      const entry = lookByKey(key);
      if (!entry) return;
      baselineRef.current = { ...entry.params };
      baselineFaceRef.current = { ...entry.face };
      setLookState(key);
      applyLook(entry.params, baselineFaceRef.current, strength);
      notify(t('toast.lookApplied', { name: t(`looks.${key}` as MessageKey) }));
    },
    [applyLook, notify, strength, t],
  );

  const setStrength = useCallback(
    (value: number) => {
      setStrengthState(value);
      applyLook(baselineRef.current, baselineFaceRef.current, value);
    },
    [applyLook],
  );

  /**
   * Run the models over a photo, without making anyone wait for them.
   *
   * The photo is on screen and editable before this starts and stays that way
   * while it runs: the analysis only decides whether the skin controls have
   * anything to act on, and every other adjustment is unaffected by it. When it
   * lands, the recipe is already whatever it was, so anything the user set in
   * the meantime takes effect at that point rather than being overwritten.
   */
  const runFaceAnalysis = useCallback(
    (image: SourceImage) => {
      setFaceState('analysing');
      setFaceCount(0);
      analysisRef.current = null;
      void (async () => {
        try {
          const analysis = await analyzeFace(asImageData(image));
          // The models take a moment to load the first time, which is long
          // enough to open a second photo. This one is no longer the subject.
          if (sourceRef.current !== image) return;
          analysisRef.current = analysis;
          pipelineRef.current?.setFaceAnalysis(analysis);
          setFaceCount(analysis.faces.length);
          setFaceState(analysis.faces.length > 0 ? 'found' : 'none');
          schedulerRef.current?.markDirty();
          notify(
            analysis.faces.length > 0
              ? t('toast.faceFound', { count: analysis.faces.length })
              : t('toast.faceNone'),
          );
        } catch (err) {
          if (sourceRef.current !== image) return;
          setFaceState('failed');
          const detail = err instanceof Error ? ` — ${err.message}` : '';
          notify(`${t('toast.faceFailed')}${detail}`, 'alert');
        }
      })();
    },
    [notify, t],
  );

  const retryFaceAnalysis = useCallback(() => {
    const image = sourceRef.current;
    if (image) runFaceAnalysis(image);
  }, [runFaceAnalysis]);

  const openFiles = useCallback(
    (files: FileList) => {
      const file = files[0];
      if (!file) return;
      void (async () => {
        try {
          const image = await decodeSourceFile(file, file.name);
          const pipeline = pipelineRef.current;
          if (!pipeline) return;
          pipeline.setSource(image);
          sourceRef.current = image;
          setSource(image);
          setStats(null);
          setThumbnails(new Map());
          // The framing belongs to the photo it was drawn on, so a new photo
          // arrives unframed rather than inheriting a crop placed on another.
          const fresh = neutralRecipe();
          const next: Recipe = {
            ...recipeRef.current,
            geometry: fresh.geometry,
            source: { w: image.width, h: image.height, space: image.space },
          };
          recipeRef.current = next;
          setRecipe(next);
          schedulerRef.current?.markDirty();
          runFaceAnalysis(image);
          notify(
            t(image.orientation === 1 ? 'toast.loaded' : 'toast.loadedRotated', {
              name: image.fileName,
              width: image.width,
              height: image.height,
            }),
          );
        } catch (err) {
          const detail = err instanceof Error ? ` — ${err.message}` : '';
          notify(`${t('toast.loadFailed')}${detail}`, 'alert');
        }
      })();
    },
    [notify, runFaceAnalysis, t],
  );

  const runAuto = useCallback(() => {
    const pipeline = pipelineRef.current;
    if (!pipeline || !sourceRef.current) return;
    // Measured against a neutral recipe: measuring the graded result would fold
    // the previous suggestion back into the next one. The framing is kept,
    // because the exposure of a photo is the exposure of the part being kept.
    const probe = neutralRecipe();
    probe.geometry = recipeRef.current.geometry;
    probe.output = recipeRef.current.output;
    // Null whenever there is no face to measure, which is what makes the
    // suggestion treat the frame as the subject rather than guess at one.
    const suggestion = suggestGrade(pipeline.measure(probe), pipeline.measureFace(probe));
    const base = { ...baselineRef.current, ...suggestion.params };
    const face = { ...baselineFaceRef.current, ...suggestion.face };
    baselineRef.current = base;
    baselineFaceRef.current = face;
    setLookState('custom');
    applyLook(base, face, strength);
    notify(
      t('toast.autoApplied', {
        notes: suggestion.notes.map((note) => formatNote(note, t)).join(' / '),
      }),
    );
  }, [applyLook, notify, strength, t]);

  const runExport = useCallback(() => {
    const pipeline = pipelineRef.current;
    const image = sourceRef.current;
    if (!pipeline || !image) return;
    setExporting(true);
    void (async () => {
      try {
        const current = recipeRef.current;
        const plan = planExport(image.width, image.height, current);
        // The export is not allowed to be behind the preview. The restore and
        // the fills the preview is showing were made on the way to a settled
        // render, and an export taken before one has happened would write the
        // generated face and the spots back in.
        await pipeline.syncPlate(current);
        const pixels = pipeline.readFullResolution(current);
        const result = await exportImage(pixels, current, image.fileName, plan.tiles, image.exif);
        const download = result.archive ?? (result.files[0] as { name: string; blob: Blob });
        const url = URL.createObjectURL(download.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = download.name;
        anchor.click();
        // Revoking in the same task can cut the download off before the browser
        // has taken the blob; one turn of the loop is enough.
        setTimeout(() => URL.revokeObjectURL(url), 0);

        const clean = result.metadata === 'removed';
        if (result.files.length > 1) {
          notify(
            t(clean ? 'toast.exportedTiles' : 'toast.exportedTilesWritten', {
              count: result.files.length,
              width: result.width,
              height: result.height,
              mime: result.mime,
            }),
            clean ? 'normal' : 'alert',
          );
        } else {
          notify(
            t(clean ? 'toast.exported' : 'toast.exportedWritten', {
              width: result.width,
              height: result.height,
              mime: result.mime,
            }),
            clean ? 'normal' : 'alert',
          );
        }
      } catch (err) {
        const detail = err instanceof Error ? ` — ${err.message}` : '';
        notify(`${t('toast.exportFailed')}${detail}`, 'alert');
      } finally {
        setExporting(false);
      }
    })();
  }, [notify, t]);

  // The framing object is replaced on every edit, so the thumbnails would rebuild
  // after any slider settled. Holding the last one whose signature actually
  // changed gives an identity that moves only when the framing does.
  const geometryKey = geometrySignature(recipe.geometry);
  const stableGeometry = useRef(recipe.geometry);
  if (geometrySignature(stableGeometry.current) !== geometryKey) {
    stableGeometry.current = recipe.geometry;
  }
  const framing = stableGeometry.current;

  // Thumbnails follow the strength dial and the framing, but only once they stop
  // moving: each one is a full evaluation of the graph at thumbnail size.
  useEffect(() => {
    if (!source) return;
    // While the analysis is still running the swatches would be built without a
    // mask and rebuilt the moment it lands. Waiting for it costs nothing on
    // screen and halves the work.
    if (faceState === 'analysing') return;
    const timer = setTimeout(() => {
      const pipeline = pipelineRef.current;
      if (!pipeline) return;
      const next = new Map<string, ImageData>();
      const base = neutralRecipe();
      for (const entry of LOOKS) {
        next.set(
          entry.key,
          pipeline.renderThumbnail(
            {
              ...base,
              geometry: framing,
              global: { ...base.global, ...applyStrength(entry.params, strength) },
              face: { ...base.face, ...applyFaceStrength(entry.face ?? {}, strength) },
              output: recipeRef.current.output,
            },
            THUMBNAIL_EDGE,
          ),
        );
      }
      setThumbnails(next);
      // The thumbnail passes left the graph cache holding their results.
      schedulerRef.current?.markDirty();
    }, 280);
    return () => clearTimeout(timer);
    // The analysis landing changes what a finish looks like, so the swatches
    // are rebuilt when it does. Showing a face untouched under a finish that
    // does touch it would make the picker answer the wrong question.
  }, [source, strength, framing, faceState]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const plan = useMemo(
    () => (source ? planExport(source.width, source.height, recipe) : null),
    [source, recipe],
  );

  const frameAspect = useMemo(() => {
    if (!source) return 1;
    const [w, h] = frameSize(source.width, source.height, recipe.geometry);
    return w / h;
  }, [source, recipe.geometry]);

  // The same matrix the renderer frames the photo with, so an overlay placing
  // something on the photograph and the shader reading it back agree by
  // construction rather than by two implementations of the framing.
  const outputToSourceMatrix = useMemo(
    () =>
      source
        ? outputToSource(source.width, source.height, recipe.geometry)
        : (MAT3_IDENTITY as Mat3),
    [source, recipe.geometry],
  );

  return useMemo(
    () => ({
      canvasRef,
      viewportRef,
      recipe,
      source,
      fatal,
      tool,
      mode,
      look,
      strength,
      comparing,
      exporting,
      stats,
      faceState,
      faceCount,
      reference,
      referenceBusy,
      restoreReport,
      toneResponse,
      thumbnails,
      scale,
      previewSize,
      workingSpace,
      toast,
      plan,
      frameAspect,
      toSource: outputToSourceMatrix,
      healRadius,
      selectedText,
      fontRevision,
      setTool,
      setMode,
      setComparing,
      setParam,
      setDepth,
      setOutput,
      setMetadata,
      setLook,
      setStrength,
      setGeometry,
      setCrop,
      setAspect,
      rotate,
      flip,
      resetFraming,
      setTiles,
      matchCropToTiles,
      setRestore,
      loadReference,
      clearReference,
      setHealRadius,
      addHealSpot,
      removeHealSpot,
      clearHeal,
      addText,
      updateText,
      removeText,
      selectText,
      loadFont,
      openFiles,
      runAuto,
      retryFaceAnalysis,
      runExport,
    }),
    [
      recipe,
      source,
      fatal,
      tool,
      mode,
      look,
      strength,
      comparing,
      exporting,
      stats,
      faceState,
      faceCount,
      reference,
      referenceBusy,
      restoreReport,
      toneResponse,
      thumbnails,
      scale,
      previewSize,
      workingSpace,
      toast,
      plan,
      frameAspect,
      outputToSourceMatrix,
      healRadius,
      selectedText,
      fontRevision,
      setTool,
      setComparing,
      setParam,
      setDepth,
      setOutput,
      setMetadata,
      setLook,
      setStrength,
      setGeometry,
      setCrop,
      setAspect,
      rotate,
      flip,
      resetFraming,
      setTiles,
      matchCropToTiles,
      setRestore,
      loadReference,
      clearReference,
      addHealSpot,
      removeHealSpot,
      clearHeal,
      addText,
      updateText,
      removeText,
      selectText,
      loadFont,
      openFiles,
      runAuto,
      retryFaceAnalysis,
      runExport,
    ],
  );
}
