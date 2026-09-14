/**
 * A button that opens a list.
 *
 * The bar has room for icons and not for lists. A native `select` fits, but it
 * cannot show an option in the face that option selects, and a font picker that
 * only names its faces is asking to be read rather than looked at. So the list
 * is drawn here, which also means the language and the appearance can sit in the
 * bar as two icons instead of two dropdowns wide enough for their longest
 * translation.
 *
 * The list is a popover, so it is drawn in the top layer. A tool panel scrolls
 * its own contents, and anything positioned inside it is clipped at the panel
 * edge — which is exactly where a list of thirty destinations would be cut off.
 * The top layer also brings the platform's own dismissal: clicking away and
 * Escape both close it without a document-wide listener.
 *
 * Being outside the panel's flow means the position has to be measured rather
 * than declared, and re-measured while the list is open, because the row it is
 * anchored to can be scrolled out from under it.
 */

import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';

export interface MenuItem {
  key: string;
  name: string;
  /** Drawn in place of the name, for an item that has to show rather than say. */
  render?: ReactNode;
  /** Secondary line, for the detail that would make the name too long. */
  hint?: string;
  /** Heading the item sits under. Consecutive items sharing one are drawn together. */
  group?: string;
}

interface MenuProps {
  /** Accessible name of the button, and its tooltip. */
  label: string;
  /** Contents of the button. An icon in the bar, a sample in a picker. */
  trigger: ReactNode;
  items: readonly MenuItem[];
  value: string;
  onSelect: (key: string) => void;
  /** Rows below a rule: actions rather than choices. */
  footer?: ReactNode;
  /** Which edge the list lines up with. */
  align?: 'start' | 'end';
  /** Draw the list at the width of the button, the way a field's list behaves. */
  stretch?: boolean;
  className?: string;
  disabled?: boolean;
}

/** Distance between the button and the list. */
const OFFSET = 6;
/** Space kept between the list and the edge of the window. */
const MARGIN = 8;

export function Menu({
  label,
  trigger,
  items,
  value,
  onSelect,
  footer,
  align = 'end',
  stretch = false,
  className = '',
  disabled = false,
}: MenuProps) {
  const list = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const id = useId();

  /**
   * Put the list against the button.
   *
   * It opens downwards unless the window has no room, which is what happens to
   * a field near the bottom of a tall panel; then it opens upwards instead of
   * being pushed off the screen.
   */
  const place = useCallback(() => {
    const node = list.current;
    const anchor = button.current;
    if (!node || !anchor) return;
    const rect = anchor.getBoundingClientRect();

    node.style.minWidth = stretch ? `${rect.width}px` : '';
    const { offsetWidth: width, offsetHeight: height } = node;

    const wanted = align === 'end' ? rect.right - width : rect.left;
    const left = Math.max(MARGIN, Math.min(wanted, window.innerWidth - width - MARGIN));

    const below = rect.bottom + OFFSET;
    const fits = below + height <= window.innerHeight - MARGIN;
    const top = fits ? below : Math.max(MARGIN, rect.top - OFFSET - height);

    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }, [align, stretch]);

  const close = useCallback(() => {
    const node = list.current;
    if (node?.matches(':popover-open')) node.hidePopover();
    button.current?.focus();
  }, []);

  // Opening is the browser's doing — the button carries `popovertarget` — so
  // what is left here is everything that has to happen once it is open.
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== 'open') return;
      place();
      // Focus lands on the current choice, so the list can be walked from where
      // it already is rather than from the top every time.
      const selected =
        node.querySelector<HTMLElement>('[aria-checked="true"]') ??
        node.querySelector<HTMLElement>('[role="menuitemradio"]');
      selected?.focus();
      selected?.scrollIntoView({ block: 'nearest' });
    };
    node.addEventListener('toggle', onToggle);
    return () => node.removeEventListener('toggle', onToggle);
  }, [place]);

  // The row the list is anchored to can scroll away underneath it.
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    const update = () => {
      if (node.matches(':popover-open')) place();
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [place]);

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);

    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = rows[(at + 1 + rows.length) % rows.length];
    else if (event.key === 'ArrowUp') next = rows[(at - 1 + rows.length) % rows.length];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows[rows.length - 1];
    else return;

    event.preventDefault();
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <div className={`menu ${className}`}>
      <button
        type="button"
        ref={button}
        className="menu-t"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={label}
        data-tip={label}
        disabled={disabled}
      >
        {trigger}
      </button>

      <div
        className="menu-l"
        id={id}
        ref={list}
        popover="auto"
        role="menu"
        aria-label={label}
        onKeyDown={onListKeyDown}
      >
        {items.map((item, index) => (
          <Fragment key={item.key}>
            {item.group && item.group !== items[index - 1]?.group && (
              <div className="menu-g" role="presentation">
                {item.group}
              </div>
            )}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={item.key === value}
              onClick={() => {
                onSelect(item.key);
                close();
              }}
            >
              <i className="menu-c" aria-hidden="true" />
              <span className="menu-n">{item.render ?? item.name}</span>
              {item.hint && <span className="menu-h">{item.hint}</span>}
            </button>
          </Fragment>
        ))}
        {footer && <div className="menu-f">{footer}</div>}
      </div>
    </div>
  );
}
