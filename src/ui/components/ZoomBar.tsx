/**
 * The magnification, along the bottom of the picture.
 *
 * A wheel and a pinch are faster than any control, so this is not primarily how
 * the view is moved — it is how the view is read. A photograph on screen is
 * always at some magnification, and without somewhere saying which, soft skin at
 * four hundred per cent and soft skin at fit are the same picture to look at and
 * a completely different judgement to make. So the readout is the point and the
 * slider comes along with it.
 *
 * It reads out per cent of the exported pixels rather than a multiple of the fit
 * size, because the number a photographer already knows what to do with is the
 * one where a hundred means one pixel of the file on one pixel of the screen.
 * Until a render has measured that relationship there is no such number, and the
 * bar says the multiple instead rather than guessing at one.
 */

import { useI18n } from '../../i18n';
import { ZOOM_STEP } from '../gestures';
import { maxZoom, oneToOneZoom, type View, ZOOM_FIT } from '../view';

interface ZoomBarProps {
  view: View;
  fitScale: number | null;
  onView: (next: View | ((current: View) => View)) => void;
  onReset: () => void;
}

/** The slider runs on the logarithm, so a step feels the same at either end. */
function toTrack(zoom: number, limit: number): number {
  return Math.log(zoom) / Math.log(limit);
}
function fromTrack(position: number, limit: number): number {
  return Math.exp(position * Math.log(limit));
}

export function ZoomBar({ view, fitScale, onView, onReset }: ZoomBarProps) {
  const { t } = useI18n();
  const limit = maxZoom(fitScale);
  const actual = oneToOneZoom(fitScale);
  const atFit = view.zoom <= ZOOM_FIT + 1e-6;
  const readout = fitScale
    ? `${Math.round(view.zoom * fitScale * 100)}%`
    : `×${view.zoom.toFixed(1)}`;

  // Every magnification is about the centre of the window. A control has no
  // pointer over the picture to hold still, and the centre is the one point the
  // person using it can see they are keeping.
  const scaleBy = (factor: number) =>
    onView((current) => ({ ...current, zoom: current.zoom * factor }));

  return (
    // A fieldset because it is a group of controls with one name, which is what
    // a fieldset is; everything it brings with it is turned off in the
    // stylesheet, where the rest of this strip's appearance lives anyway.
    <fieldset className="zoombar" aria-label={t('zoom.label')}>
      <button
        type="button"
        className="zoombar-b"
        data-on={atFit ? 'yes' : undefined}
        onClick={onReset}
      >
        {t('zoom.fit')}
      </button>
      <button
        type="button"
        className="zoombar-i"
        aria-label={t('zoom.out')}
        disabled={atFit}
        onClick={() => scaleBy(1 / ZOOM_STEP)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14" />
        </svg>
      </button>
      <input
        className="zoombar-track"
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={toTrack(view.zoom, limit)}
        aria-label={t('zoom.label')}
        aria-valuetext={readout}
        onChange={(event) =>
          onView((current) => ({
            ...current,
            zoom: fromTrack(Number(event.target.value), limit),
          }))
        }
      />
      <button
        type="button"
        className="zoombar-i"
        aria-label={t('zoom.in')}
        disabled={view.zoom >= limit - 1e-6}
        onClick={() => scaleBy(ZOOM_STEP)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <span className="zoombar-v mono">{readout}</span>
      {/* Absent rather than dimmed on a photo that is already being shown past
          its own pixels: there is no one-to-one to go to, and a disabled button
          would say there is one and it is out of reach. */}
      {actual !== null && (
        <button
          type="button"
          className="zoombar-b"
          onClick={() => onView((current) => ({ ...current, zoom: actual }))}
        >
          {t('zoom.actual')}
        </button>
      )}
    </fieldset>
  );
}
