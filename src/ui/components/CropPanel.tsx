/**
 * Framing: turn it, level it, decide what stays.
 *
 * The shape list is the panel's centre of gravity. Choosing where a photo is
 * going is the same decision as choosing what shape to cut it to, so the places
 * it might go are named here instead of leaving someone to remember that a feed
 * wants four by five.
 */

import { ASPECTS, aspectByKey } from '../../core/geometry/aspects';
import type { ExportPlan } from '../../core/geometry/tiles';
import { flipFieldFor } from '../../core/geometry/transform';
import type { GeometryParams } from '../../core/recipe/schema';
import { type MessageKey, useI18n } from '../../i18n';
import { spec } from '../params';
import { Choice, Slider } from './controls';

interface CropPanelProps {
  geometry: GeometryParams;
  plan: ExportPlan | null;
  hasImage: boolean;
  onGeometry: (patch: Partial<GeometryParams>) => void;
  onAspect: (key: string) => void;
  onRotate: (quarterTurns: number) => void;
  onFlip: (axis: 'h' | 'v') => void;
  onReset: () => void;
}

const STRAIGHTEN = spec('geometry.straighten', 'crop.straighten');

/** The arrow curls the way the photo turns. Mirroring it reverses the direction. */
function RotateIcon({ clockwise }: { clockwise: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" style={clockwise ? { scale: '-1 1' } : undefined}>
      <path d="M4 12a8 8 0 1 1 2.34 5.66" />
      <path d="M4 6v5h5" />
    </svg>
  );
}

export function CropPanel({
  geometry,
  plan,
  hasImage,
  onGeometry,
  onAspect,
  onRotate,
  onFlip,
  onReset,
}: CropPanelProps) {
  const { t } = useI18n();

  const preset = aspectByKey(geometry.aspect);
  const shapes = ASPECTS.map((entry) => ({
    key: entry.key,
    name: t(`aspect.${entry.key}` as MessageKey),
    group: t(`aspectGroup.${entry.group}` as MessageKey),
    // The shapes group is named by its ratios already; a destination is not.
    ...(entry.longEdge > 0 ? { hint: `${entry.shape} · ${entry.longEdge}px` } : {}),
  }));

  // What one exported file will actually be, measured rather than repeated back
  // from the preset: a photo that cannot reach the destination's size is not
  // enlarged to it, and that is worth saying here rather than in the export
  // panel, while the crop that caused it is still under the cursor.
  const tile = plan?.tiles[0];
  const reached = tile ? Math.max(tile.width, tile.height) : 0;
  const short =
    preset !== undefined && preset.longEdge > 0 && reached > 0 && reached < preset.longEdge;

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="tool-body">
          <div className="seclabel">{t('crop.rotate')}</div>
          <div className="iconrow">
            <button
              type="button"
              className="ibtn"
              disabled={!hasImage}
              aria-label={t('crop.rotateLeft')}
              data-tip={t('crop.rotateLeft')}
              onClick={() => onRotate(-1)}
            >
              <RotateIcon clockwise={false} />
            </button>
            <button
              type="button"
              className="ibtn"
              disabled={!hasImage}
              aria-label={t('crop.rotateRight')}
              data-tip={t('crop.rotateRight')}
              onClick={() => onRotate(1)}
            >
              <RotateIcon clockwise />
            </button>
            <button
              type="button"
              className="ibtn"
              disabled={!hasImage}
              aria-pressed={geometry[flipFieldFor(geometry.quarterTurns, 'h')]}
              aria-label={t('crop.flipH')}
              data-tip={t('crop.flipH')}
              onClick={() => onFlip('h')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3v18" />
                <path d="M9 7 4 12l5 5z" />
                <path d="M15 7l5 5-5 5z" />
              </svg>
            </button>
            <button
              type="button"
              className="ibtn"
              disabled={!hasImage}
              aria-pressed={geometry[flipFieldFor(geometry.quarterTurns, 'v')]}
              aria-label={t('crop.flipV')}
              data-tip={t('crop.flipV')}
              onClick={() => onFlip('v')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 12h18" />
                <path d="M7 9 12 4l5 5z" />
                <path d="M7 15l5 5 5-5z" />
              </svg>
            </button>
          </div>

          <Slider
            spec={STRAIGHTEN}
            value={geometry.straighten}
            onChange={(straighten) => onGeometry({ straighten })}
          />
          <p className="mini">{t('crop.straightenNote')}</p>

          <Choice
            label={t('crop.aspect')}
            value={geometry.aspect}
            items={shapes}
            onChange={onAspect}
          />

          {preset?.note ? (
            <p className="mini">{t(preset.note as MessageKey)}</p>
          ) : (
            <p className="mini">{t('crop.hint')}</p>
          )}

          {plan && (
            <div className="readout">
              <span>{t('crop.result')}</span>
              <b className="mono">
                {plan.width}×{plan.height}
              </b>
            </div>
          )}

          {short && (
            <p className="mini alert">
              {t('crop.belowTarget', { size: preset.longEdge, actual: reached })}
            </p>
          )}

          <button
            type="button"
            className="tomore"
            disabled={!hasImage || (isUnframed(geometry) && !aspectByKey(geometry.aspect)?.ratio)}
            onClick={onReset}
          >
            {t('crop.reset')}
          </button>
        </div>
      </div>
    </div>
  );
}

function isUnframed(geometry: GeometryParams): boolean {
  return (
    geometry.quarterTurns === 0 &&
    !geometry.flipH &&
    !geometry.flipV &&
    geometry.straighten === 0 &&
    geometry.crop.w === 1 &&
    geometry.crop.h === 1
  );
}
