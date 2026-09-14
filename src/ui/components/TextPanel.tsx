/**
 * Text layers.
 *
 * One layer is edited at a time. A caption has a dozen properties and the photo
 * usually carries one or two captions, so a list of collapsed rows with a full
 * editor under the selected one beats a list of rows that each carry a dozen
 * controls.
 */

import { useMemo } from 'react';
import type { TextLayer } from '../../core/recipe/schema';
import { fontByKey, missingGlyphs } from '../../core/text/fonts';
import { useI18n } from '../../i18n';
import { spec } from '../params';
import { ColorField, Segmented, Slider } from './controls';
import { FontPicker } from './FontPicker';

const SIZE = spec('text.size', 'text.size');
const OPACITY = spec('text.opacity', 'text.opacity');
const ROTATION = spec('text.rotation', 'text.rotation');
const TRACKING = spec('text.tracking', 'text.tracking');
const LINE_HEIGHT = spec('text.lineHeight', 'text.lineHeight');
const OUTLINE = spec('text.outline', 'text.outline');
const SHADOW = spec('text.shadow', 'text.shadow');
const BACKGROUND = spec('text.background', 'text.background');

const WEIGHTS = [
  { key: '300', nameKey: 'text.weightLight' },
  { key: '500', nameKey: 'text.weightRegular' },
  { key: '700', nameKey: 'text.weightBold' },
] as const;

const ALIGNMENTS = [
  { key: 'left', nameKey: 'text.alignLeft' },
  { key: 'center', nameKey: 'text.alignCenter' },
  { key: 'right', nameKey: 'text.alignRight' },
] as const;

interface TextPanelProps {
  layers: readonly TextLayer[];
  selected: string | null;
  hasImage: boolean;
  /** Bumped when a face finishes loading, so the picker and the check re-run. */
  fontRevision: number;
  onAdd: () => void;
  onSelect: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<TextLayer>) => void;
  onRemove: (id: string) => void;
  onLoadFont: (file: File) => void;
}

export function TextPanel({
  layers,
  selected,
  hasImage,
  fontRevision,
  onAdd,
  onSelect,
  onUpdate,
  onRemove,
  onLoadFont,
}: TextPanelProps) {
  const { t } = useI18n();
  const active = layers.find((layer) => layer.id === selected) ?? layers.at(-1) ?? null;

  // A face loaded from a file has no fallback of its own, so a caption can hold
  // characters it cannot draw. The check runs against the caption as typed
  // rather than against a sample, because it is that caption that gets exported.
  const content = active?.content ?? '';
  const face = active?.font ?? '';
  const missing = useMemo(
    // `fontRevision` is the second input: the catalogue of loaded faces lives
    // outside React, so a face arriving is not otherwise visible from here.
    () => (fontRevision >= 0 && content ? missingGlyphs(content, face) : []),
    [content, face, fontRevision],
  );
  const unknownFont = active !== null && fontByKey(active.font) === undefined;

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="tool-body">
          <button type="button" className="auto" disabled={!hasImage} onClick={onAdd}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 6h14" />
              <path d="M12 6v13" />
            </svg>
            {t('text.add')}
          </button>

          {layers.length === 0 && <p className="mini">{t('text.empty')}</p>}

          {layers.length > 1 && (
            <div className="layers">
              {layers.map((layer, index) => (
                <button
                  key={layer.id}
                  type="button"
                  className="layer"
                  aria-pressed={layer.id === active?.id}
                  onClick={() => onSelect(layer.id)}
                >
                  <span className="layer-n">{t('text.layer', { n: index + 1 })}</span>
                  <span className="layer-c">{layer.content.split('\n')[0]}</span>
                </button>
              ))}
            </div>
          )}

          {active && (
            <>
              <label className="field">
                <span className="field-l">{t('text.content')}</span>
                <textarea
                  value={active.content}
                  rows={3}
                  placeholder={t('text.placeholder')}
                  onChange={(event) => onUpdate(active.id, { content: event.target.value })}
                />
              </label>

              <FontPicker
                value={active.font}
                sample={active.content}
                onChange={(font) => onUpdate(active.id, { font })}
                onLoadFile={onLoadFont}
              />
              {unknownFont && <p className="warn">{t('text.fontMissing')}</p>}
              {missing.length > 0 && (
                <p className="warn">
                  {t('text.fontGaps', { chars: missing.slice(0, 12).join(' ') })}
                </p>
              )}

              <Segmented
                label={t('text.weight')}
                options={WEIGHTS.map((weight) => ({
                  key: weight.key,
                  name: t(weight.nameKey),
                }))}
                value={String(active.weight)}
                onChange={(weight) => onUpdate(active.id, { weight: Number(weight) })}
              />

              <Segmented
                label={t('text.align')}
                options={ALIGNMENTS.map((align) => ({ key: align.key, name: t(align.nameKey) }))}
                value={active.align}
                onChange={(align) => onUpdate(active.id, { align })}
              />

              <ColorField
                label={t('text.color')}
                value={active.color}
                onChange={(color) => onUpdate(active.id, { color })}
              />

              <Slider
                spec={SIZE}
                value={active.size}
                onChange={(size) => onUpdate(active.id, { size })}
              />
              <Slider
                spec={OPACITY}
                value={active.opacity}
                onChange={(opacity) => onUpdate(active.id, { opacity })}
              />
              <Slider
                spec={ROTATION}
                value={active.rotation}
                onChange={(rotation) => onUpdate(active.id, { rotation })}
              />
              <Slider
                spec={TRACKING}
                value={active.tracking}
                onChange={(tracking) => onUpdate(active.id, { tracking })}
              />
              <Slider
                spec={LINE_HEIGHT}
                value={active.lineHeight}
                onChange={(lineHeight) => onUpdate(active.id, { lineHeight })}
              />

              <Slider
                spec={OUTLINE}
                value={active.outline}
                onChange={(outline) => onUpdate(active.id, { outline })}
              />
              {active.outline > 0.001 && (
                <ColorField
                  label={t('text.outlineColor')}
                  value={active.outlineColor}
                  onChange={(outlineColor) => onUpdate(active.id, { outlineColor })}
                />
              )}

              <Slider
                spec={SHADOW}
                value={active.shadow}
                onChange={(shadow) => onUpdate(active.id, { shadow })}
              />

              <Slider
                spec={BACKGROUND}
                value={active.background}
                onChange={(background) => onUpdate(active.id, { background })}
              />
              {active.background > 0.001 && (
                <ColorField
                  label={t('text.backgroundColor')}
                  value={active.backgroundColor}
                  onChange={(backgroundColor) => onUpdate(active.id, { backgroundColor })}
                />
              )}

              <p className="mini">{t('text.relative')}</p>

              <button type="button" className="tomore danger" onClick={() => onRemove(active.id)}>
                {t('text.remove')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
