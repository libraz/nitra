/**
 * Putting the photographed face back over a generated one.
 *
 * The only tool that takes a second file, so the panel is mostly about that
 * file: which one it is, what was found in it, and how well it lined up. The two
 * amounts come after, because neither means anything until a reference is here.
 *
 * The measurement is the point of the readout rather than decoration. A patch
 * whose fit left a large residual is one laid over a face the generator gave a
 * different shape or pose, and nothing in the result says so on its own — the
 * seam is invisible and the face is subtly in the wrong place. So the number is
 * shown whether or not it is bad, and only the wording changes.
 */

import { useRef } from 'react';
import type { Recipe } from '../../core/recipe/schema';
import type { RestoreReport } from '../../core/render/pipeline';
import { useI18n } from '../../i18n';
import { spec } from '../params';
import type { ReferenceState } from '../useEditor';
import { Slider } from './controls';

const EDGE = spec('restore.edge', 'restore.edge');
const MATCH = spec('restore.match', 'restore.match');

/**
 * Residual past which the fit stops describing the same face.
 *
 * A fraction of a face width, and not yet measured against a set of real
 * generated frames — it is where a mismatch becomes visible on the one case it
 * was set against, which is the honest limit of it. It decides the wording of a
 * note and nothing else: the patch is applied either way, because refusing on an
 * uncalibrated number would withhold the working case more often than it would
 * catch the broken one.
 */
const RESIDUAL_LIMIT = 0.03;

interface RestorePanelProps {
  restore: Recipe['restore'];
  reference: ReferenceState | null;
  busy: boolean;
  report: RestoreReport | null;
  hasImage: boolean;
  faceCount: number;
  onLoad: (file: File) => void;
  onClear: () => void;
  onChange: (patch: Partial<Recipe['restore']>) => void;
}

export function RestorePanel({
  restore,
  reference,
  busy,
  report,
  hasImage,
  faceCount,
  onLoad,
  onClear,
  onChange,
}: RestorePanelProps) {
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Three states, not two. The recipe names a photograph and the session holds
  // one, and either can change without the other: a recipe written yesterday or
  // a remount leaves the name with nothing behind it, and undoing past the point
  // where a photograph was opened leaves the two naming different files. Without
  // the third, that last one is a panel showing a loaded reference, no sliders,
  // no restore and no reason given — which is the shape of a bug report.
  const missing = restore.reference !== '' && reference === null;
  const active = reference !== null && restore.reference === reference.fileName;
  const mismatch = reference !== null && !active;

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="tool-body">
          <div className="seclabel">{t('restore.title')}</div>

          {hasImage ? (
            <p className="mini">{t('restore.how')}</p>
          ) : (
            <p className="mini">{t('restore.noImage')}</p>
          )}

          <button
            type="button"
            className="tomore"
            disabled={!hasImage || busy}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? t('restore.loading') : t('restore.open')}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,.heic,.heif"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so choosing the same file twice fires again, which is
              // what somebody who just replaced the file on disk expects.
              event.target.value = '';
              if (file) onLoad(file);
            }}
          />

          {reference && (
            <>
              <div className="readout">
                <span>{reference.fileName}</span>
                <b className="mono">
                  {reference.width}×{reference.height}
                </b>
              </div>
              <div className="readout">
                <span>{t('restore.referenceFaces', { count: reference.faces })}</span>
              </div>
              <button type="button" className="tomore" onClick={onClear}>
                {t('restore.clear')}
              </button>
            </>
          )}

          {missing && (
            <p className="mini alert">{t('restore.missing', { name: restore.reference })}</p>
          )}

          {mismatch && (
            <>
              <p className="mini alert">
                {restore.reference === ''
                  ? t('restore.unused', { open: reference.fileName })
                  : t('restore.mismatch', {
                      wanted: restore.reference,
                      open: reference.fileName,
                    })}
              </p>
              <button
                type="button"
                className="tomore"
                onClick={() => onChange({ reference: reference.fileName })}
              >
                {t('restore.adopt', { name: reference.fileName })}
              </button>
            </>
          )}

          {active && faceCount === 0 && <p className="mini alert">{t('restore.noFaceHere')}</p>}

          {active && (
            <>
              <Slider
                spec={EDGE}
                value={restore.edge}
                onChange={(value) => onChange({ edge: value })}
              />
              <p className="mini">{t('restore.edgeNote')}</p>

              <Slider
                spec={MATCH}
                value={restore.match}
                onChange={(value) => onChange({ match: value })}
              />
              <p className="mini">{t('restore.matchNote')}</p>
            </>
          )}

          {report && (
            <div className="readout">
              <span>{t('restore.paired', { count: report.paired })}</span>
              <b className="mono">{report.residual.toFixed(3)}</b>
            </div>
          )}

          {report && report.unpaired > 0 && (
            <p className="mini alert">{t('restore.unpaired', { count: report.unpaired })}</p>
          )}

          {report && report.paired > 0 && (
            <p className={report.residual > RESIDUAL_LIMIT ? 'mini alert' : 'mini'}>
              {t(report.residual > RESIDUAL_LIMIT ? 'restore.residualHigh' : 'restore.residualOk')}
            </p>
          )}

          <div className="note">
            <b>{t('restore.aboutTitle')}</b>
            <span>{t('restore.aboutBody')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
