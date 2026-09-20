/**
 * Concealing a reflection.
 *
 * Same bones as the blemish panel — a size to choose before the click, a count,
 * and the way back — with one button that does the common case on its own.
 *
 * There is no amount. The bottom of an amount slider is a reflection that is
 * still readable, which is the one state this tool may not offer; what the size
 * controls is how much of the picture the guarantee covers, not how strong it
 * is. So the panel's remaining job is to say what the ring promises and what it
 * costs, which is the catchlight of any eye it is drawn over.
 */

import { CONCEAL_LIMIT, type Recipe } from '../../core/recipe/schema';
import { useI18n } from '../../i18n';
import { spec } from '../params';
import { Slider } from './controls';

const SIZE = spec('conceal.r', 'conceal.size');

interface ConcealPanelProps {
  spots: Recipe['conceal'];
  radius: number;
  hasImage: boolean;
  /** Irises the analysis found, over every face. Zero disables the one click. */
  irisCount: number;
  onRadius: (value: number) => void;
  onSeedIrises: () => void;
  onRemoveLast: () => void;
  onClear: () => void;
}

export function ConcealPanel({
  spots,
  radius,
  hasImage,
  irisCount,
  onRadius,
  onSeedIrises,
  onRemoveLast,
  onClear,
}: ConcealPanelProps) {
  const { t } = useI18n();
  const full = spots.length >= CONCEAL_LIMIT;

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="tool-body">
          <div className="seclabel">{t('conceal.title')}</div>

          {hasImage ? (
            <p className="mini">{t('conceal.how')}</p>
          ) : (
            <p className="mini">{t('conceal.noImage')}</p>
          )}

          <Slider spec={SIZE} value={radius} onChange={onRadius} />
          <p className="mini">{t('conceal.sizeNote')}</p>

          <button
            type="button"
            className="tomore"
            disabled={!hasImage || irisCount === 0 || full}
            onClick={onSeedIrises}
          >
            {t('conceal.irises', { count: irisCount })}
          </button>
          {hasImage && irisCount === 0 && <p className="mini">{t('conceal.irisesNone')}</p>}
          <p className="mini">{t('conceal.cost')}</p>

          <div className="readout">
            <span>{t('conceal.count', { count: spots.length })}</span>
            {full && <b className="mono">{t('conceal.full')}</b>}
          </div>

          <button
            type="button"
            className="tomore"
            disabled={spots.length === 0}
            onClick={onRemoveLast}
          >
            {t('conceal.removeLast')}
          </button>
          <button type="button" className="tomore" disabled={spots.length === 0} onClick={onClear}>
            {t('conceal.clear')}
          </button>

          <div className="note">
            <b>{t('conceal.aboutTitle')}</b>
            <span>{t('conceal.aboutBody')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
