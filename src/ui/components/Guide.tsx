/**
 * The guide.
 *
 * Someone arriving here has been handed an empty editor with every tool
 * disabled until a photo is open, and the one question they have not asked out
 * loud is where their photo is about to be sent. That answer is the first step;
 * the rest is the shortest path from an empty screen to an exported file.
 *
 * It opens by itself exactly once. A visit that has seen it is recorded, and
 * after that the guide is only ever opened from the bar — an editor that
 * explains itself again every morning is one that gets closed unread.
 *
 * The dialog is the platform's own: `showModal` takes care of the backdrop, the
 * focus trap, the inert background and Escape, and none of the four are worth
 * reimplementing badly.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type MessageKey, useI18n } from '../../i18n';

const STORAGE_KEY = 'nitra.guide';
const REPO = 'https://github.com/libraz/nitra';

export interface GuideStep {
  key: string;
  title: MessageKey;
  body: MessageKey;
  note: MessageKey;
}

/**
 * The steps, in the order the work happens.
 *
 * Exported as data so the catalogue can be checked against it: a step added
 * without its three messages would otherwise reach the screen as a raw key.
 */
export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    key: 'privacy',
    title: 'guide.privacy.title',
    body: 'guide.privacy.body',
    note: 'guide.privacy.note',
  },
  { key: 'open', title: 'guide.open.title', body: 'guide.open.body', note: 'guide.open.note' },
  {
    key: 'finish',
    title: 'guide.finish.title',
    body: 'guide.finish.body',
    note: 'guide.finish.note',
  },
  {
    key: 'export',
    title: 'guide.export.title',
    body: 'guide.export.body',
    note: 'guide.export.note',
  },
];

const STEP_ICONS: Record<string, ReactNode> = {
  privacy: (
    <>
      <path d="M12 3l7 3v5.5c0 4.3-2.9 7.6-7 8.5-4.1-.9-7-4.2-7-8.5V6z" />
      <path d="M9.4 12.2l1.9 1.9 3.5-3.7" />
    </>
  ),
  open: (
    <>
      <path d="M3 7h6l2 2h10v10H3z" />
    </>
  ),
  finish: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  export: (
    <>
      <path d="M12 3v12" />
      <path d="M8 11l4 4 4-4" />
      <path d="M4 19h16" />
    </>
  ),
};

/** Whether this visit has been shown the guide before. */
export function guideSeen(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'seen';
  } catch {
    // Storage can be refused outright. Showing the guide once per visit is a
    // better failure than never showing it at all.
    return false;
  }
}

export function rememberGuideSeen(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, 'seen');
  } catch {
    // Nothing to do: the guide simply opens again on the next visit.
  }
}

interface GuideProps {
  open: boolean;
  /** Opened by itself on a first visit, rather than asked for from the bar. */
  firstRun: boolean;
  onClose: () => void;
  /** The last step ends on the file picker rather than on a button saying "done". */
  onOpenPhoto: () => void;
}

export function Guide({ open, firstRun, onClose, onOpenPhoto }: GuideProps) {
  const { t } = useI18n();
  const [at, setAt] = useState(0);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const primary = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      setAt(0);
      node.showModal();
      // Opening a modal moves focus to the first thing in it, which here is a
      // step marker. Focus belongs on the thing there is to do next.
      primary.current?.focus();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  // Dismissing by clicking away is wired to the element rather than through a
  // JSX prop: the backdrop is a region, not a control, and everything it does
  // is also on a button inside the dialog. A click that reaches the dialog
  // element itself came from the backdrop — the content is in children.
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const onClick = (event: MouseEvent) => {
      if (event.target === node) onClose();
    };
    node.addEventListener('click', onClick);
    return () => node.removeEventListener('click', onClick);
  }, [onClose]);

  const finish = useCallback(() => {
    onClose();
    onOpenPhoto();
  }, [onClose, onOpenPhoto]);

  const step = GUIDE_STEPS[at] as GuideStep;
  const last = at === GUIDE_STEPS.length - 1;

  return (
    <dialog className="guide" ref={dialog} aria-label={t('topbar.help')} onClose={onClose}>
      {/* Keyed on the step so the body plays its transition again on each one. */}
      <div className="guide-b" key={step.key}>
        <span className="sr-only">{t('guide.step', { n: at + 1, total: GUIDE_STEPS.length })}</span>

        {/* The icon sits on its own line so every line of type shares one left edge. */}
        <div className="guide-h">
          <svg className="guide-i" viewBox="0 0 24 24" aria-hidden="true">
            {STEP_ICONS[step.key]}
          </svg>
          <span className="guide-n mono" aria-hidden="true">
            {at + 1} / {GUIDE_STEPS.length}
          </span>
        </div>

        <h2>{t(step.title)}</h2>

        <p className="guide-p">{t(step.body)}</p>
        <p className="guide-note">{t(step.note)}</p>

        {last && (
          <a className="guide-repo" href={REPO} target="_blank" rel="noreferrer">
            {t('guide.repo')}
          </a>
        )}
      </div>

      <footer className="guide-f">
        <div className="guide-dots">
          {GUIDE_STEPS.map((entry, index) => (
            <button
              key={entry.key}
              type="button"
              aria-label={t(entry.title)}
              aria-current={index === at}
              onClick={() => setAt(index)}
            />
          ))}
        </div>

        <div className="spacer" />

        {/*
          Both buttons keep their identity across the steps, so the focus a
          keyboard put on "next" is still there after the step changes.
        */}
        <button type="button" className="tbtn" onClick={at > 0 ? () => setAt(at - 1) : onClose}>
          {t(at > 0 ? 'guide.back' : firstRun ? 'guide.skip' : 'guide.close')}
        </button>

        <button
          type="button"
          className="tbtn primary"
          ref={primary}
          onClick={last ? finish : () => setAt(at + 1)}
        >
          {t(last ? 'guide.start' : 'guide.next')}
        </button>
      </footer>
    </dialog>
  );
}
