/**
 * The image area.
 *
 * Comparison is press-and-hold rather than a toggle: holding is what makes the
 * two states feel like one image being switched, and it cannot be left on by
 * accident.
 *
 * The canvas is wrapped in a plate that shrinks to fit it. The renderer sets the
 * canvas to whatever size the picture's shape allows, and the overlays are
 * absolutely positioned inside the plate, so a handle drawn at 30% of the way
 * across is 30% of the way across the photo without anyone having to compute
 * where the photo ended up.
 */

import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { type MessageKey, useI18n } from '../../i18n';
import { useStageGestures } from '../gestures';
import type { Tool } from '../useEditor';
import { type View, viewTransform } from '../view';
import { ZoomBar } from './ZoomBar';

interface StageProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** The box the image is fitted into; the renderer measures it. */
  viewportRef: RefObject<HTMLDivElement | null>;
  hasImage: boolean;
  comparing: boolean;
  tool: Tool;
  view: View;
  fitScale: number | null;
  overlay: ReactNode;
  onCompare: (on: boolean) => void;
  onView: (next: View | ((current: View) => View)) => void;
  onResetView: () => void;
  onFiles: (files: FileList) => void;
  onPick: () => void;
  onHelp: () => void;
}

/** Which affordances are worth naming for the tool that is open. */
function hintsFor(tool: Tool): [MessageKey, MessageKey][] {
  switch (tool) {
    case 'crop':
      return [['stage.hintCrop', 'stage.hintCropText']];
    case 'text':
      return [['stage.hintText', 'stage.hintTextText']];
    case 'heal':
      return [
        ['stage.hintHeal', 'stage.hintHealText'],
        ['stage.hintHealBack', 'stage.hintHealBackText'],
      ];
    case 'conceal':
      return [
        ['stage.hintConceal', 'stage.hintConcealText'],
        ['stage.hintConcealBack', 'stage.hintConcealBackText'],
      ];
    default:
      return [
        ['stage.hintHold', 'stage.hintHoldText'],
        ['stage.hintZoom', 'stage.hintZoomText'],
        ['stage.hintReset', 'stage.hintResetText'],
        ['stage.hintDrop', 'stage.hintDropText'],
      ];
  }
}

export function Stage({
  canvasRef,
  viewportRef,
  hasImage,
  comparing,
  tool,
  view,
  fitScale,
  overlay,
  onCompare,
  onView,
  onResetView,
  onFiles,
  onPick,
  onHelp,
}: StageProps) {
  const { t } = useI18n();
  const [dragOver, setDragOver] = useState(false);
  const holding = useRef(false);
  const stage = useRef<HTMLElement | null>(null);
  // The window the view is mapped against. It is the picture at its fit size,
  // which is also the box the magnified plate is clipped to, so one element
  // answers both questions.
  const frame = useRef<HTMLDivElement | null>(null);

  const release = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    onCompare(false);
  }, [onCompare]);

  useStageGestures({
    host: viewportRef,
    frame,
    view,
    fitScale,
    enabled: hasImage,
    // The two tools whose own gesture is a drag on the picture keep it. Every
    // other tool presses without travelling, so a drag there is free to be the
    // hand — which is what a magnified photograph has to answer to on a phone,
    // where there is no second button and no space bar to reach for.
    panOnDrag: tool !== 'crop' && tool !== 'text',
    onView,
    // A press that turns into a drag was a press first, and on the tools that
    // compare that already put the original on screen. Panning the original
    // around would be a hand on the wrong picture.
    onPanStart: release,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '\\' && !event.repeat) onCompare(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === '\\') onCompare(false);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [onCompare, release]);

  // Drag and drop is wired directly to the element rather than through JSX
  // props: dropping a file is a pointer affordance on a region, not a control,
  // and everything it does is also reachable from the button in the top bar.
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const over = (event: DragEvent) => {
      event.preventDefault();
      setDragOver(true);
    };
    const leave = () => setDragOver(false);
    const drop = (event: DragEvent) => {
      event.preventDefault();
      setDragOver(false);
      if (event.dataTransfer?.files.length) onFiles(event.dataTransfer.files);
    };
    node.addEventListener('dragover', over);
    node.addEventListener('dragleave', leave);
    node.addEventListener('drop', drop);
    return () => {
      node.removeEventListener('dragover', over);
      node.removeEventListener('dragleave', leave);
      node.removeEventListener('drop', drop);
    };
  }, [onFiles]);

  return (
    <section className="stage" ref={stage} aria-label={t('stage.dropTitle')}>
      <div className="viewport" ref={viewportRef}>
        <div className={hasImage ? 'frame' : 'frame empty'} ref={frame}>
          {/* The magnification is a transform on the plate rather than a
              different size of canvas, so the overlays inside it are carried
              along by the same number that moved the picture and go on being
              positioned against the photograph. The canvas is given more pixels
              to match — see `RenderOptions.zoom` — so what is magnified is the
              photograph and not the fitted copy of it. */}
          <div className="plate" style={{ transform: viewTransform(view) }}>
            <canvas
              ref={canvasRef}
              hidden={!hasImage}
              onPointerDown={(event) => {
                // Holding to compare would fight a crop drag or a caption drag,
                // so it belongs to the tools that are only looking at the photo.
                // The two that place circles are excluded for the same reason:
                // a press on the picture is already a placement.
                if (
                  event.button !== 0 ||
                  tool === 'crop' ||
                  tool === 'text' ||
                  tool === 'heal' ||
                  tool === 'conceal'
                )
                  return;
                holding.current = true;
                onCompare(true);
              }}
            />
            {hasImage && overlay}
          </div>
          {!hasImage && (
            <div className={dragOver ? 'dropzone over' : 'dropzone'}>
              <b>{t('stage.dropTitle')}</b>
              <span>
                {t('stage.formats')}
                <br />
                {t('stage.privacy')}
              </span>
              <button type="button" className="tbtn" onClick={onPick}>
                {t('stage.pick')}
              </button>
              <button type="button" className="linkb" onClick={onHelp}>
                {t('topbar.help')}
              </button>
            </div>
          )}
          {comparing && hasImage && <div className="origtag mono">{t('stage.original')}</div>}
        </div>
      </div>

      {hasImage && (
        <div className="hint">
          {hintsFor(tool).map(([key, text]) => (
            <span key={key}>
              <kbd>{t(key)}</kbd>
              {t(text)}
            </span>
          ))}
        </div>
      )}

      {hasImage && (
        <ZoomBar view={view} fitScale={fitScale} onView={onView} onReset={onResetView} />
      )}
    </section>
  );
}
