/**
 * The modal plumbing both sheets share.
 *
 * The dialog is the platform's own: `showModal` takes care of the backdrop, the
 * focus trap, the inert background and Escape, and none of the four are worth
 * reimplementing badly. What is left is opening it from a React state flag and
 * dismissing it by clicking away, and that much is identical for every sheet —
 * two copies of it is where the guide and the about sheet would start behaving
 * differently from each other.
 */

import { type RefObject, useEffect, useRef } from 'react';

export function useSheet(open: boolean, onClose: () => void): RefObject<HTMLDialogElement | null> {
  const dialog = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    else if (!open && node.open) node.close();
  }, [open]);

  // Dismissing by clicking away is wired to the element rather than through a
  // JSX prop: the backdrop is a region, not a control, and everything it does is
  // also on a button inside the sheet. A click that reaches the dialog element
  // itself came from the backdrop — the content is in children.
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const onClick = (event: MouseEvent) => {
      if (event.target === node) onClose();
    };
    node.addEventListener('click', onClick);
    return () => node.removeEventListener('click', onClick);
  }, [onClose]);

  return dialog;
}
