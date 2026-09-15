/**
 * Detail mode.
 *
 * This is the panel that behaves like a tool: every parameter, its number always
 * visible and always typeable, grouped and collapsible, with a mark on any group
 * that has been touched. Nothing is trimmed here — trimming is what simple mode
 * is for.
 *
 * Two things make it usable once a lot has been changed. The header counts what
 * has moved and can put everything back, because an edit that went too far is
 * undone from one place rather than by hunting through eight groups. And the
 * changed-only filter turns the panel into a list of the decisions actually
 * made, which is what gets read back before an export.
 */

import { useMemo, useState } from 'react';
import { APERTURES, type DepthParams, HUE_BANDS, type Recipe } from '../../core/recipe/schema';
import { type MessageKey, useI18n } from '../../i18n';
import { bandParams, GROUPS, groupTouched, type ParamSpec, readParam } from '../params';
import type { FaceState } from '../useEditor';
import { Segmented, Slider } from './controls';
import { FaceStatus } from './FaceStatus';
import { ToneCurve } from './ToneCurve';

/** Swatches for the band buttons, in the order {@link HUE_BANDS} declares. */
const BAND_SWATCH: Record<string, string> = {
  red: '#e0453c',
  orange: '#e08a33',
  yellow: '#d8c033',
  green: '#4caa52',
  cyan: '#39b3b8',
  blue: '#4a72d0',
  purple: '#8a5fce',
  magenta: '#c8499b',
};

interface DetailPanelProps {
  recipe: Recipe;
  toneResponse: Uint8Array | null;
  faceState: FaceState;
  faceCount: number;
  onParam: (path: string, value: number) => void;
  onDepth: (patch: Partial<DepthParams>) => void;
  onRetryFace: () => void;
  onSimple: () => void;
}

function isTouched(recipe: Recipe, param: ParamSpec): boolean {
  return Math.abs(readParam(recipe, param.path) - param.neutral) > 1e-6;
}

/**
 * The shape of the iris the defocus is convolved with.
 *
 * A picker rather than a slider because the three are not a range: a hexagon is
 * not half way between a circle and an ellipse, it is a different lens.
 */
function AperturePicker({
  value,
  disabled,
  onChange,
}: {
  value: DepthParams['aperture'];
  disabled: boolean;
  onChange: (aperture: DepthParams['aperture']) => void;
}) {
  const { t } = useI18n();
  return (
    <Segmented
      label={t('aperture.label')}
      value={value}
      disabled={disabled}
      options={APERTURES.map((aperture) => ({
        key: aperture,
        name: t(`aperture.${aperture}` as MessageKey),
      }))}
      onChange={onChange}
    />
  );
}

/** Every parameter in the panel, bands included, as one flat list. */
function allParams(): ParamSpec[] {
  const out: ParamSpec[] = [];
  for (const group of GROUPS) {
    if (group.special === 'bands') {
      for (const band of HUE_BANDS) out.push(...bandParams(band));
    }
    out.push(...group.params);
  }
  return out;
}

/**
 * The per-hue sliders, for one band at a time.
 *
 * Twenty-four sliders is a wall. Showing three and letting the band be picked by
 * its colour keeps the control the same size as every other group, and the
 * colour is the thing being reached for anyway.
 */
function BandMixer({
  recipe,
  changedOnly,
  onParam,
}: {
  recipe: Recipe;
  changedOnly: boolean;
  onParam: (path: string, value: number) => void;
}) {
  const { t } = useI18n();
  const [band, setBand] = useState<string>('red');
  const shown = bandParams(band).filter((param) => !changedOnly || isTouched(recipe, param));

  return (
    <>
      <div className="bands">
        {HUE_BANDS.map((key) => {
          const touched = bandParams(key).some((param) => isTouched(recipe, param));
          return (
            <button
              key={key}
              type="button"
              className="band"
              aria-pressed={key === band}
              aria-label={t(`bands.${key}` as MessageKey)}
              data-tip={t(`bands.${key}` as MessageKey)}
              data-touched={touched}
              style={{ background: BAND_SWATCH[key] }}
              onClick={() => setBand(key)}
            />
          );
        })}
      </div>
      <div className="bandname">{t(`bands.${band}` as MessageKey)}</div>
      {shown.map((param) => (
        <Slider
          key={param.path}
          spec={param}
          value={readParam(recipe, param.path)}
          onChange={(value) => onParam(param.path, value)}
        />
      ))}
    </>
  );
}

export function DetailPanel({
  recipe,
  toneResponse,
  faceState,
  faceCount,
  onParam,
  onDepth,
  onRetryFace,
  onSimple,
}: DetailPanelProps) {
  const { t } = useI18n();
  const [changedOnly, setChangedOnly] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(GROUPS.map((group) => [group.id, group.defaultOpen ?? false])),
  );

  const changed = useMemo(() => allParams().filter((param) => isTouched(recipe, param)), [recipe]);

  const resetAll = () => {
    for (const param of changed) onParam(param.path, param.neutral);
  };

  // With the filter on, a group with nothing changed in it is not collapsed —
  // it is absent. A row of empty headers is the wall the filter exists to remove.
  const groups = GROUPS.filter((group) => !changedOnly || groupTouched(recipe, group));

  return (
    <div className="pane">
      <div className="pane-head">
        <span className="pane-count" data-on={changed.length > 0}>
          {changed.length > 0 ? t('detail.modified', { count: changed.length }) : t('detail.clean')}
        </span>
        <button
          type="button"
          className="chip"
          aria-pressed={changedOnly}
          disabled={changed.length === 0}
          onClick={() => setChangedOnly((was) => !was)}
        >
          {t('detail.onlyModified')}
        </button>
        <button
          type="button"
          className="chip"
          disabled={changed.length === 0}
          onClick={resetAll}
          data-tip={t('detail.resetAll')}
          aria-label={t('detail.resetAll')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5v5h5" />
            <path d="M4.6 14a7.5 7.5 0 1 0 1.3-6.4" />
          </svg>
        </button>
      </div>

      <div className="pane-scroll">
        <div className="groups">
          {groups.length === 0 && <p className="mini pad">{t('detail.filterEmpty')}</p>}

          {groups.map((group) => {
            const isOpen = changedOnly || (open[group.id] ?? false);
            const touched = groupTouched(recipe, group);
            // A group that needs a face is shown either way: the values are part
            // of the edit and stay part of it, whether or not this photograph is
            // one the stage can reach.
            const inert = (group.requiresFace ?? false) && faceState !== 'found';
            const params = group.params.filter((param) => !changedOnly || isTouched(recipe, param));
            return (
              <section className="grp" key={group.id} data-open={isOpen} data-touched={touched}>
                <div className="grp-h">
                  <button
                    type="button"
                    className="grp-b-t"
                    aria-expanded={isOpen}
                    onClick={() => setOpen((prev) => ({ ...prev, [group.id]: !isOpen }))}
                  >
                    <i className="chev" />
                    <span className="gn">{t(group.nameKey)}</span>
                    <i className="dot" />
                  </button>
                  {touched && (
                    <button
                      type="button"
                      className="grp-r"
                      aria-label={`${t(group.nameKey)} — ${t('detail.resetGroup')}`}
                      data-tip={t('detail.resetGroup')}
                      onClick={() => {
                        const reset =
                          group.special === 'bands'
                            ? HUE_BANDS.flatMap((band) => bandParams(band))
                            : group.params;
                        for (const param of reset) {
                          if (isTouched(recipe, param)) onParam(param.path, param.neutral);
                        }
                      }}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 5v5h5" />
                        <path d="M4.6 14a7.5 7.5 0 1 0 1.3-6.4" />
                      </svg>
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="grp-b">
                    {group.requiresFace && group.id === 'skin' && (
                      <FaceStatus state={faceState} count={faceCount} onRetry={onRetryFace} />
                    )}
                    {group.special === 'curve' && !changedOnly && (
                      <ToneCurve response={toneResponse} />
                    )}
                    {group.special === 'bands' && (
                      <BandMixer recipe={recipe} changedOnly={changedOnly} onParam={onParam} />
                    )}
                    {group.special === 'aperture' && !changedOnly && (
                      <AperturePicker
                        value={recipe.depth.aperture}
                        disabled={inert}
                        onChange={(aperture) => onDepth({ aperture })}
                      />
                    )}
                    {params.map((param) => (
                      <Slider
                        key={param.path}
                        spec={param}
                        value={readParam(recipe, param.path)}
                        disabled={inert}
                        onChange={(value) => onParam(param.path, value)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}

          <button type="button" className="tomore wide" onClick={onSimple}>
            {t('detail.toSimple')}
          </button>
        </div>
      </div>
    </div>
  );
}
