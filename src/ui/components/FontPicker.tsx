/**
 * Choosing a typeface.
 *
 * Every face is drawn in itself, including the one on the button. A list of
 * names is a list that has to be read and remembered; a list of samples is one
 * that can be looked at, and the difference matters most for the faces someone
 * has loaded from their own machine, whose names are file names.
 */

import { type ChangeEvent, useRef } from 'react';
import { allFonts, isFontFile } from '../../core/text/fonts';
import { type MessageKey, useI18n } from '../../i18n';
import { Menu } from './menu';

/** What a face is shown setting, when the caption itself is still empty. */
const SPECIMEN = 'Aa あ漢';

interface FontPickerProps {
  value: string;
  /** The caption's own text, so the sample is the thing being set. */
  sample: string;
  onChange: (key: string) => void;
  onLoadFile: (file: File) => void;
}

/** The message key a built-in face is named by. */
function nameKey(key: string): MessageKey {
  return `text.font${key.charAt(0).toUpperCase()}${key.slice(1)}` as MessageKey;
}

export function FontPicker({ value, sample, onChange, onLoadFile }: FontPickerProps) {
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const fonts = allFonts();
  const current = fonts.find((font) => font.key === value);
  const specimen = sample.split('\n')[0]?.trim().slice(0, 14) || SPECIMEN;

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file && isFontFile(file)) onLoadFile(file);
  };

  return (
    <div className="fontf">
      <span className="fontf-l">{t('text.font')}</span>
      <Menu
        className="fontf-m"
        align="start"
        stretch
        label={t('text.font')}
        value={value}
        onSelect={onChange}
        items={fonts.map((font) => ({
          key: font.key,
          name: font.custom ? font.label : t(nameKey(font.key)),
          render: (
            <span className="fontf-s" style={{ fontFamily: font.stack }}>
              {specimen}
            </span>
          ),
          hint: font.custom ? font.label : t(nameKey(font.key)),
        }))}
        trigger={
          <>
            <span className="fontf-c" style={{ fontFamily: current?.stack }}>
              {current ? (current.custom ? current.label : t(nameKey(current.key))) : value}
            </span>
            <i className="fontf-x" aria-hidden="true" />
          </>
        }
        footer={
          <button type="button" className="menu-a" onClick={() => fileInput.current?.click()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4" />
              <path d="M8 8l4-4 4 4" />
              <path d="M4 20h16" />
            </svg>
            {t('text.fontLoad')}
          </button>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept=".otf,.ttf,.woff,.woff2,.ttc,font/*"
        hidden
        onChange={onFile}
      />
    </div>
  );
}
