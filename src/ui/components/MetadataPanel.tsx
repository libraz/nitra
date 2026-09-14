/**
 * What the exported file says about itself.
 *
 * Removal is still the default and still the first thing on the screen. What
 * this adds is the other two answers: carry across what the photo arrived with,
 * or write a block field by field.
 *
 * Every field shown here is a field that gets written, and every field that gets
 * written is shown here. There is no pass-through of the original block, so
 * there is nothing in the export that this panel did not list.
 */

import { useState } from 'react';
import type { SourceExif } from '../../core/io/exif';
import { isEmptyExif } from '../../core/io/exif';
import { formatCoordinates, formatShutter, parseCoordinates } from '../../core/io/metadata';
import type { MetadataParams, OutputParams } from '../../core/recipe/schema';
import { useI18n } from '../../i18n';
import { NumberField, Segmented, SwitchRow, TextField } from './controls';

type Patch = {
  mode?: MetadataParams['mode'];
  gps?: Partial<MetadataParams['gps']>;
  capture?: Partial<MetadataParams['capture']>;
  credit?: Partial<MetadataParams['credit']>;
  software?: boolean;
};

interface MetadataPanelProps {
  metadata: MetadataParams;
  format: OutputParams['format'];
  /** What the open photo arrived carrying, or null when none is open. */
  source: SourceExif | null;
  onMetadata: (patch: Patch) => void;
}

/** A line of the summary, shown only when the photo actually carries it. */
function Row({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="readout">
      <span>{label}</span>
      <b className="mono">{value}</b>
    </div>
  );
}

/**
 * Somewhere to paste a coordinate pair.
 *
 * A location gets copied out of a map as one string, and splitting it by hand
 * into two number fields is the step where the sign goes missing. What was typed
 * stays put whether or not it parses, so a half-typed pair is not swallowed.
 */
function CoordinatePaste({
  onParsed,
}: {
  onParsed: (value: { latitude: number; longitude: number }) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  return (
    <TextField
      label={t('metadata.paste')}
      value={text}
      placeholder="35.65858, 139.74543"
      onChange={(next) => {
        setText(next);
        const parsed = parseCoordinates(next);
        if (parsed) onParsed(parsed);
      }}
    />
  );
}

function SourceSummary({ exif }: { exif: SourceExif }) {
  const { t } = useI18n();
  const body: string[] = [];
  if (exif.fNumber > 0) body.push(`f/${Number(exif.fNumber.toFixed(1))}`);
  if (exif.exposureTime > 0) body.push(formatShutter(exif.exposureTime));
  if (exif.iso > 0) body.push(`ISO ${exif.iso}`);
  if (exif.focalLength > 0) body.push(`${Number(exif.focalLength.toFixed(0))}mm`);

  return (
    <div className="summary">
      <Row label={t('metadata.fieldCamera')} value={[exif.make, exif.model].join(' ').trim()} />
      <Row label={t('metadata.fieldLens')} value={exif.lens} />
      <Row label={t('metadata.fieldTaken')} value={exif.taken.replace('T', ' ')} />
      <Row label={t('metadata.fieldExposure')} value={body.join(' · ')} />
      <Row
        label={t('metadata.fieldLocation')}
        value={exif.gps ? formatCoordinates(exif.gps.latitude, exif.gps.longitude) : ''}
      />
      <Row label={t('metadata.fieldArtist')} value={exif.artist} />
      <Row label={t('metadata.fieldCopyright')} value={exif.copyright} />
    </div>
  );
}

export function MetadataPanel({ metadata, format, source, onMetadata }: MetadataPanelProps) {
  const { t } = useI18n();
  const { gps, capture, credit } = metadata;
  const carried = source !== null && !isEmptyExif(source);
  const writes = metadata.mode !== 'strip';

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="tool-body">
          <Segmented
            label={t('metadata.mode')}
            options={[
              { key: 'strip', name: t('metadata.modeStrip') },
              { key: 'keep', name: t('metadata.modeKeep') },
              { key: 'custom', name: t('metadata.modeCustom') },
            ]}
            value={metadata.mode}
            onChange={(mode) => onMetadata({ mode: mode as MetadataParams['mode'] })}
          />

          {metadata.mode === 'strip' && <p className="mini">{t('metadata.stripNote')}</p>}

          {writes && format === 'webp' && <p className="warn">{t('metadata.webpUnsupported')}</p>}

          {metadata.mode === 'keep' &&
            (carried && source ? (
              <>
                <p className="mini">{t('metadata.keepNote')}</p>
                <SourceSummary exif={source} />
              </>
            ) : (
              <p className="mini">{t('metadata.sourceEmpty')}</p>
            ))}

          {metadata.mode === 'custom' && (
            <>
              <p className="warn">{t('metadata.recipeCarries')}</p>

              <section className="block" data-on={gps.write}>
                <SwitchRow
                  label={t('metadata.gps')}
                  hint={t('metadata.gpsHint')}
                  on={gps.write}
                  onChange={(write) => onMetadata({ gps: { write } })}
                />
                {gps.write && (
                  <>
                    <CoordinatePaste onParsed={(parsed) => onMetadata({ gps: parsed })} />
                    <NumberField
                      label={t('metadata.latitude')}
                      value={gps.latitude}
                      min={-90}
                      max={90}
                      step={0.00001}
                      unit="°"
                      onChange={(latitude) => onMetadata({ gps: { latitude } })}
                    />
                    <NumberField
                      label={t('metadata.longitude')}
                      value={gps.longitude}
                      min={-180}
                      max={180}
                      step={0.00001}
                      unit="°"
                      onChange={(longitude) => onMetadata({ gps: { longitude } })}
                    />
                    <NumberField
                      label={t('metadata.altitude')}
                      value={gps.altitude}
                      min={-11000}
                      max={30000}
                      step={1}
                      unit="m"
                      onChange={(altitude) => onMetadata({ gps: { altitude } })}
                    />
                    {source?.gps && (
                      <button
                        type="button"
                        className="tomore"
                        onClick={() =>
                          source.gps &&
                          onMetadata({
                            gps: {
                              latitude: source.gps.latitude,
                              longitude: source.gps.longitude,
                              altitude: source.gps.altitude,
                            },
                          })
                        }
                      >
                        {t('metadata.copyFromPhoto')}
                      </button>
                    )}
                  </>
                )}
              </section>

              <section className="block" data-on={capture.write}>
                <SwitchRow
                  label={t('metadata.capture')}
                  hint={t('metadata.captureHint')}
                  on={capture.write}
                  onChange={(write) => onMetadata({ capture: { write } })}
                />
                {capture.write && (
                  <>
                    <TextField
                      label={t('metadata.fieldTaken')}
                      type="datetime-local"
                      value={capture.taken}
                      onChange={(taken) => onMetadata({ capture: { taken } })}
                    />
                    <TextField
                      label={t('metadata.fieldMake')}
                      value={capture.make}
                      onChange={(make) => onMetadata({ capture: { make } })}
                    />
                    <TextField
                      label={t('metadata.fieldModel')}
                      value={capture.model}
                      onChange={(model) => onMetadata({ capture: { model } })}
                    />
                    <TextField
                      label={t('metadata.fieldLens')}
                      value={capture.lens}
                      onChange={(lens) => onMetadata({ capture: { lens } })}
                    />
                    <NumberField
                      label={t('metadata.fieldAperture')}
                      value={capture.fNumber}
                      min={0}
                      max={256}
                      step={0.1}
                      unit="f"
                      onChange={(fNumber) => onMetadata({ capture: { fNumber } })}
                    />
                    <NumberField
                      label={t('metadata.fieldShutter')}
                      value={capture.exposureTime}
                      min={0}
                      max={3600}
                      step={0.0001}
                      unit="s"
                      placeholder="0.004"
                      onChange={(exposureTime) => onMetadata({ capture: { exposureTime } })}
                    />
                    <NumberField
                      label={t('metadata.fieldIso')}
                      value={capture.iso}
                      min={0}
                      max={4194304}
                      step={1}
                      unit="ISO"
                      onChange={(iso) => onMetadata({ capture: { iso: Math.round(iso) } })}
                    />
                    <NumberField
                      label={t('metadata.fieldFocal')}
                      value={capture.focalLength}
                      min={0}
                      max={10000}
                      step={1}
                      unit="mm"
                      onChange={(focalLength) => onMetadata({ capture: { focalLength } })}
                    />
                    {carried && source && (
                      <button
                        type="button"
                        className="tomore"
                        onClick={() =>
                          onMetadata({
                            capture: {
                              taken: source.taken,
                              make: source.make,
                              model: source.model,
                              lens: source.lens,
                              iso: source.iso,
                              fNumber: source.fNumber,
                              exposureTime: source.exposureTime,
                              focalLength: source.focalLength,
                            },
                          })
                        }
                      >
                        {t('metadata.copyFromPhoto')}
                      </button>
                    )}
                  </>
                )}
              </section>

              <section className="block" data-on={credit.write}>
                <SwitchRow
                  label={t('metadata.credit')}
                  hint={t('metadata.creditHint')}
                  on={credit.write}
                  onChange={(write) => onMetadata({ credit: { write } })}
                />
                {credit.write && (
                  <>
                    <TextField
                      label={t('metadata.fieldArtist')}
                      value={credit.artist}
                      onChange={(artist) => onMetadata({ credit: { artist } })}
                    />
                    <TextField
                      label={t('metadata.fieldCopyright')}
                      value={credit.copyright}
                      onChange={(copyright) => onMetadata({ credit: { copyright } })}
                    />
                    <TextField
                      label={t('metadata.fieldDescription')}
                      value={credit.description}
                      onChange={(description) => onMetadata({ credit: { description } })}
                    />
                    <p className="mini">{t('metadata.nonAsciiNote')}</p>
                  </>
                )}
              </section>

              <SwitchRow
                label={t('metadata.software')}
                hint={t('metadata.softwareHint')}
                on={metadata.software}
                onChange={(software) => onMetadata({ software })}
              />
            </>
          )}

          <div className="mini">
            <b>{t('metadata.keepsIcc')}</b>
            {t('metadata.keepsIccWhy')}
          </div>
        </div>
      </div>
    </div>
  );
}
