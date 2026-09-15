/**
 * What this thing is, and who is behind it.
 *
 * An editor that asks for a photo and promises not to send it anywhere owes an
 * answer to "whose editor is this". One sentence answers it; the two links are
 * there because the sentence is only worth anything if it can be checked.
 *
 * It is reached from the wordmark in the status bar, which is where a desktop
 * application keeps its own name.
 */

import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n';
import { PROJECT_LINKS, VERSION } from '../project';
import { useSheet } from './sheet';

interface AboutProps {
  open: boolean;
  onClose: () => void;
  /** The guide is the other half of the answer: what the app does, rather than whose it is. */
  onHelp: () => void;
}

export function About({ open, onClose, onHelp }: AboutProps) {
  const { t } = useI18n();
  const dialog = useSheet(open, onClose);
  const primary = useRef<HTMLButtonElement | null>(null);

  // Opening a modal moves focus to the first thing in it, which here is a link
  // off the page. Focus belongs on the way back to the photo.
  useEffect(() => {
    if (open) primary.current?.focus();
  }, [open]);

  return (
    <dialog className="sheet about" ref={dialog} aria-label={t('about.open')} onClose={onClose}>
      <div className="about-b">
        <div className="about-h">
          <span className="wm">nitra</span>
          <span className="about-v mono" aria-hidden="true">
            {VERSION}
          </span>
          <span className="sr-only">{t('about.version', { version: VERSION })}</span>
        </div>

        <p className="about-tag">{t('app.tagline')}</p>
        <p className="about-p">{t('about.body')}</p>

        <div className="about-links">
          {PROJECT_LINKS.map((link) => (
            <a
              key={link.key}
              className="about-link"
              href={link.href}
              target="_blank"
              rel="noreferrer"
            >
              <span className="about-link-n">{t(link.label)}</span>
              <svg className="about-link-x" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 16L16 8" />
                <path d="M10.5 8H16v5.5" />
              </svg>
            </a>
          ))}
        </div>
      </div>

      <footer className="sheet-f">
        <button type="button" className="linkb" onClick={onHelp}>
          {t('topbar.help')}
        </button>
        <div className="spacer" />
        <button type="button" className="tbtn primary" ref={primary} onClick={onClose}>
          {t('guide.close')}
        </button>
      </footer>
    </dialog>
  );
}
