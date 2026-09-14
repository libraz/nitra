/**
 * What the face analysis found, said out loud.
 *
 * It exists because the skin controls do nothing without a face, and the app
 * knows why. Leaving them live and inert would make a photograph of a landscape
 * look like a bug in the sliders; saying "no face in this photo" costs one line
 * and answers it completely.
 *
 * The three outcomes are not one message with a number in it. A face found is
 * confirmation, no face is a fact about the photograph, and an analysis that
 * could not run is a fact about this session and the only one of the three with
 * anything to do about it.
 */

import { useI18n } from '../../i18n';
import type { FaceState } from '../useEditor';

interface FaceStatusProps {
  state: FaceState;
  count: number;
  onRetry: () => void;
  /**
   * Say it without the count.
   *
   * Simple mode shows no numbers at all, and that holds for a count of faces as
   * much as for a slider value. The constraint is what forces the mode to be a
   * different thing rather than a shortened version of the other one, so it does
   * not get an exception for being a small number.
   */
  numberless?: boolean;
}

export function FaceStatus({ state, count, onRetry, numberless = false }: FaceStatusProps) {
  const { t } = useI18n();
  if (state === 'idle') return null;

  if (state === 'analysing') {
    return (
      <p className="facenote" data-state="busy">
        <b>{t('face.analysing')}</b>
      </p>
    );
  }

  if (state === 'found') {
    return (
      <p className="facenote" data-state="ok">
        <b>{numberless ? t('face.foundPlain') : t('face.found', { count })}</b>
      </p>
    );
  }

  if (state === 'none') {
    return (
      <p className="facenote" data-state="off">
        <b>{t('face.none')}</b>
        <span>{t('face.noneWhy')}</span>
      </p>
    );
  }

  return (
    <p className="facenote" data-state="warn">
      <b>{t('face.failed')}</b>
      <span>{t('face.failedWhy')}</span>
      <button type="button" className="chip" onClick={onRetry}>
        {t('face.retry')}
      </button>
    </p>
  );
}
