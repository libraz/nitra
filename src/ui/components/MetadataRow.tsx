/**
 * The metadata switch.
 *
 * It is on the first screen of simple mode, not behind a settings panel. A photo
 * of a face is about to be posted somewhere, and the home address sitting in its
 * GPS tag is not a detail to make someone go looking for.
 *
 * The switch only ever moves between removing everything and carrying the photo's
 * own data across. Writing a block field by field is a decision with a panel
 * behind it, and a toggle that could silently undo that panel's work is not a
 * toggle worth having — so a recipe already set that way is reported here and
 * left alone until the switch is actually used.
 */

import type { MetadataParams } from '../../core/recipe/schema';
import { useI18n } from '../../i18n';
import { Toggle } from './controls';

interface MetadataRowProps {
  mode: MetadataParams['mode'];
  onMode: (mode: MetadataParams['mode']) => void;
  detail?: boolean;
}

export function MetadataRow({ mode, onMode, detail = false }: MetadataRowProps) {
  const { t } = useI18n();
  const removing = mode === 'strip';

  const title = removing
    ? t('metadata.onTitle')
    : mode === 'custom'
      ? t('metadata.customTitle')
      : t('metadata.offTitle');

  const body = removing
    ? t(detail ? 'metadata.onBodyDetail' : 'metadata.onBody')
    : mode === 'custom'
      ? t('metadata.customBody')
      : t('metadata.offBody');

  return (
    <div className={removing ? 'meta-row' : 'meta-row off'}>
      <span className="mi">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3l8 3.5v5c0 4.6-3.2 8.7-8 9.5-4.8-.8-8-4.9-8-9.5v-5z" />
          {removing ? <path d="M9 12l2 2 4-4" /> : <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />}
        </svg>
      </span>
      <span className="mt">
        <b>{title}</b>
        {body}
      </span>
      <Toggle
        on={removing}
        label={t('metadata.toggle')}
        onChange={(on) => onMode(on ? 'strip' : 'keep')}
      />
    </div>
  );
}
