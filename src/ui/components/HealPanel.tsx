/**
 * Filling blemishes, one at a time.
 *
 * This is the only tool that works by pointing at the photograph rather than by
 * moving an amount, so the panel's job is mostly to say what a click will do and
 * to offer the way back. The size is here because it has to be chosen before the
 * click, not after it: a spot keeps the size it was placed at.
 */

import { HEAL_LIMIT, type Recipe } from '../../core/recipe/schema';
import { useI18n } from '../../i18n';
import { spec } from '../params';
import { Slider } from './controls';

const SIZE = spec('heal.r', 'heal.size');

interface HealPanelProps {
  spots: Recipe['heal'];
  radius: number;
  hasImage: boolean;
  onRadius: (value: number) => void;
  onRemoveLast: () => void;
  onClear: () => void;
}

export function HealPanel({
  spots,
  radius,
  hasImage,
  onRadius,
  onRemoveLast,
  onClear,
}: HealPanelProps) {
  const { t } = useI18n();
  const full = spots.length >= HEAL_LIMIT;

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="tool-body">
          <div className="seclabel">{t('heal.title')}</div>

          {hasImage ? (
            <p className="mini">{t('heal.how')}</p>
          ) : (
            <p className="mini">{t('heal.noImage')}</p>
          )}

          <Slider spec={SIZE} value={radius} onChange={onRadius} />
          <p className="mini">{t('heal.sizeNote')}</p>

          <div className="readout">
            <span>{t('heal.count', { count: spots.length })}</span>
            {full && <b className="mono">{t('heal.full')}</b>}
          </div>

          <button
            type="button"
            className="tomore"
            disabled={spots.length === 0}
            onClick={onRemoveLast}
          >
            {t('heal.removeLast')}
          </button>
          <button type="button" className="tomore" disabled={spots.length === 0} onClick={onClear}>
            {t('heal.clear')}
          </button>

          <div className="note">
            <b>{t('heal.aboutTitle')}</b>
            <span>{t('heal.aboutBody')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
