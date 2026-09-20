/**
 * Moving the view with a pointer.
 *
 * Nothing here decides where the view ends up — that is {@link view}, which is
 * arithmetic and testable without a browser. This file is the other half: which
 * gesture means zoom, which means pan, and how not to take a gesture away from
 * the tool that was already using it.
 *
 * The two live apart because the awkward part of a viewer is the arbitration,
 * not the maths. A wheel and a pinch both magnify, but one has a pointer to
 * magnify about and the other has a moving centre that is also panning; the same
 * press is the hand, the comparison, a crop corner and a blemish. Keeping the
 * arbitration in one place is what stops a second gesture from being bolted onto
 * whichever component happened to see the event first.
 *
 * The rule the whole file turns on: **a press is claimed when it travels, not
 * when it lands.** Everything a photograph is pressed on — a blemish, the
 * comparison, a ring to take back — is a press that stays still, and dragging a
 * magnified photograph is the one that does not. That is what lets one finger on
 * a phone and the plain left button both move the picture without any of those
 * four losing the gesture they had.
 */

import { type RefObject, useEffect, useRef } from 'react';
import { FIT_VIEW, maxZoom, oneToOneZoom, panBy, type View, ZOOM_FIT, zoomAbout } from './view';

/** What one notch, one keystroke or one button press is worth. */
export const ZOOM_STEP = 1.5;

/**
 * How far a press travels before it is a drag, in client pixels.
 *
 * Wide enough to survive the wobble of lifting a finger off glass, which is what
 * would otherwise turn every tap into a pan of a pixel or two; narrow enough
 * that it is not felt as the picture refusing to move.
 */
export const PAN_THRESHOLD = 5;

/**
 * How hard a wheel pushes.
 *
 * A trackpad reports pixels and a wheel reports lines, and the two differ by
 * more than an order of magnitude per event, so the delta is normalised to
 * pixels before it is turned into a magnification. The exponential is what makes
 * the gesture reversible: the same scroll back undoes it exactly, which a linear
 * step does not.
 */
const WHEEL_GAIN = 0.0025;
const LINE_HEIGHT = 16;
const PAGE_HEIGHT = 400;

/** The most one event may do, so a flung trackpad cannot cross the whole range. */
const WHEEL_LIMIT = 4;

function wheelFactor(event: WheelEvent): number {
  const unit = event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? PAGE_HEIGHT : 1;
  const factor = Math.exp(-event.deltaY * unit * WHEEL_GAIN);
  return Math.min(WHEEL_LIMIT, Math.max(1 / WHEEL_LIMIT, factor));
}

export interface StageGestureOptions {
  /** Where the gestures are listened for. */
  host: RefObject<HTMLElement | null>;
  /** The window the view is mapped against: the picture at its fit size. */
  frame: RefObject<HTMLElement | null>;
  view: View;
  fitScale: number | null;
  enabled: boolean;
  /**
   * Whether a plain drag is the hand here.
   *
   * False for the tools whose whole gesture is a drag on the picture — the crop
   * rectangle and the caption. There the hand needs the space bar or the middle
   * button, because waiting to see whether the press travels is no use when
   * travelling is what the tool does too.
   */
  panOnDrag: boolean;
  onView: (next: View | ((current: View) => View)) => void;
  /** The press has been taken away from whatever it landed on. */
  onPanStart?: () => void;
}

/**
 * Wheel, pinch and hand.
 *
 * Bound imperatively and read through a ref, for the reason the crop overlay
 * gives: a gesture is a stream of events, and rebinding the listeners on every
 * frame of one would tear them down mid-drag.
 */
export function useStageGestures({
  host,
  frame,
  view,
  fitScale,
  enabled,
  panOnDrag,
  onView,
  onPanStart,
}: StageGestureOptions): void {
  const latest = useRef({ view, fitScale, enabled, panOnDrag, onView, onPanStart });
  latest.current = { view, fitScale, enabled, panOnDrag, onView, onPanStart };
  // Held out here because the cursor is answered from two places: the listeners
  // below, and the effect that has to refresh it when the magnification changed
  // without anybody touching the picture — from the zoom bar, or a keystroke.
  const spaceHeld = useRef(false);

  const magnified = enabled && view.zoom > ZOOM_FIT + 1e-6;

  useEffect(() => {
    const node = host.current;
    if (!node) return;

    /** Where a client point sits inside the picture's own box, as a fraction of it. */
    const inFrame = (clientX: number, clientY: number): [number, number] => {
      const box = frame.current?.getBoundingClientRect();
      if (!box || box.width < 1 || box.height < 1) return [0.5, 0.5];
      return [
        Math.min(Math.max((clientX - box.left) / box.width, 0), 1),
        Math.min(Math.max((clientY - box.top) / box.height, 0), 1),
      ];
    };

    /** A drag in client pixels, as a fraction of the picture's box. */
    const inFrameDelta = (dx: number, dy: number): [number, number] => {
      const box = frame.current?.getBoundingClientRect();
      if (!box || box.width < 1 || box.height < 1) return [0, 0];
      return [dx / box.width, dy / box.height];
    };

    const limit = () => maxZoom(latest.current.fitScale);
    const isMagnified = () => latest.current.view.zoom > ZOOM_FIT + 1e-6;
    /** Whether a plain drag is the hand right now, rather than something the tool owns. */
    const dragPans = () => latest.current.enabled && latest.current.panOnDrag && isMagnified();

    /**
     * The pointers currently down over the picture.
     *
     * Two of them is a pinch, and the second one arriving is also the moment a
     * tool has to be taken off the gesture: propagation stops from here on, so
     * a crop drag under the first finger ends where it was rather than following
     * a hand that is now zooming.
     */
    const down = new Map<number, { x: number; y: number }>();
    let pinch: { distance: number; cx: number; cy: number } | null = null;
    let hand: { x: number; y: number; id: number } | null = null;
    /** A press that will become a hand if it travels, and stay the tool's if not. */
    let armed: { x: number; y: number; id: number } | null = null;

    const setGrab = (state: '' | 'ready' | 'active') => {
      if (state) node.dataset.grab = state;
      else delete node.dataset.grab;
    };
    /** The cursor with nothing being dragged: an open hand wherever one would work. */
    const restingGrab = () =>
      isMagnified() && (latest.current.panOnDrag || spaceHeld.current) ? 'ready' : '';

    /** Take the press away from whatever it landed on and start dragging the picture. */
    const claim = (event: PointerEvent, from: { x: number; y: number; id: number }) => {
      armed = null;
      hand = from;
      // Capture is what keeps the moves coming once the drag has left the
      // stage, and it is refused for a pointer that is no longer down — which
      // is a race, not a mistake. Letting it throw out of a pointermove handler
      // would end the drag rather than merely bound it to the stage.
      try {
        node.setPointerCapture(event.pointerId);
      } catch {}
      setGrab('active');
      latest.current.onPanStart?.();
      event.stopPropagation();
    };

    const measurePinch = () => {
      const [a, b] = [...down.values()];
      if (!a || !b) return null;
      return {
        distance: Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
    };

    const onWheel = (event: WheelEvent) => {
      if (!latest.current.enabled) return;
      // Held down, a wheel is the browser's own page zoom, so the default has to
      // go whether or not the modifier is what asked for the magnification here.
      event.preventDefault();
      const [px, py] = inFrame(event.clientX, event.clientY);
      latest.current.onView((current) => zoomAbout(current, wheelFactor(event), px, py, limit()));
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!latest.current.enabled) return;
      const at = { x: event.clientX, y: event.clientY, id: event.pointerId };
      if (event.pointerType === 'mouse') {
        // The middle button and the space bar take the press outright: they are
        // unambiguous, so there is nothing to wait to find out, and they work
        // inside the crop and caption tools where a plain drag cannot.
        if (event.button === 1 || (event.button === 0 && spaceHeld.current)) {
          if (!isMagnified()) return;
          claim(event, at);
          event.preventDefault();
          return;
        }
        if (event.button === 0 && dragPans()) armed = at;
        return;
      }
      down.set(event.pointerId, at);
      if (down.size >= 2) {
        // A second finger settles what the first one was: a pinch, never a drag
        // of the picture and never a tap on it.
        armed = null;
        pinch = measurePinch();
        event.stopPropagation();
        return;
      }
      if (dragPans()) armed = at;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (
        armed &&
        event.pointerId === armed.id &&
        Math.hypot(event.clientX - armed.x, event.clientY - armed.y) >= PAN_THRESHOLD
      ) {
        // Dragged from where the press landed rather than from here, so the
        // picture does not jump by the few pixels it took to tell the two
        // gestures apart.
        claim(event, armed);
      }
      if (hand && event.pointerId === hand.id) {
        const [dx, dy] = inFrameDelta(event.clientX - hand.x, event.clientY - hand.y);
        hand = { ...hand, x: event.clientX, y: event.clientY };
        latest.current.onView((current) => panBy(current, dx, dy, limit()));
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!down.has(event.pointerId)) return;
      down.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!pinch || down.size < 2) return;
      const next = measurePinch();
      if (!next) return;
      const previous = pinch;
      pinch = next;
      // Both at once, and in this order: the fingers spreading is the
      // magnification and the pair drifting is the pan, so a pinch that also
      // slides moves the picture the way a hand on paper would.
      const [px, py] = inFrame(previous.cx, previous.cy);
      const [dx, dy] = inFrameDelta(next.cx - previous.cx, next.cy - previous.cy);
      latest.current.onView((current) =>
        panBy(
          zoomAbout(current, next.distance / previous.distance, px, py, limit()),
          dx,
          dy,
          limit(),
        ),
      );
      event.preventDefault();
      event.stopPropagation();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (armed && event.pointerId === armed.id) armed = null;
      if (hand && event.pointerId === hand.id) {
        hand = null;
        down.delete(event.pointerId);
        if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
        setGrab(restingGrab());
        // The release that ends a drag is not a click. Letting it through is how
        // a pan that finished over a blemish fills it.
        event.stopPropagation();
        return;
      }
      const wasPinching = pinch !== null;
      down.delete(event.pointerId);
      if (down.size < 2) pinch = null;
      // The finger that is left is not the start of a tap: it has been on the
      // picture throughout a zoom, and letting its release place a circle is how
      // a pinch ends with a blemish filled somewhere nobody pointed at.
      if (wasPinching) event.stopPropagation();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (event.code === 'Space') {
        if (event.repeat || spaceHeld.current) return;
        spaceHeld.current = true;
        if (!hand) setGrab(restingGrab());
        return;
      }
      // The browser's own magnification shortcuts, taken over while a photograph
      // is open. Zooming the page would scale the picture along with the panel
      // and the readouts, which is the one thing a retouching view must not do:
      // what is on screen has to be the photograph at a magnification somebody
      // can name.
      if (!latest.current.enabled || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const actual = oneToOneZoom(latest.current.fitScale);
      if (event.key === '0') {
        latest.current.onView(FIT_VIEW);
      } else if (event.key === '1' && actual !== null) {
        latest.current.onView((current) => ({ ...current, zoom: actual }));
      } else if (event.key === '+' || event.key === '=') {
        latest.current.onView((current) => ({ ...current, zoom: current.zoom * ZOOM_STEP }));
      } else if (event.key === '-' || event.key === '_') {
        latest.current.onView((current) => ({ ...current, zoom: current.zoom / ZOOM_STEP }));
      } else {
        return;
      }
      event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      spaceHeld.current = false;
      if (!hand) setGrab(restingGrab());
    };
    // A window that loses focus mid-gesture never sees the key come back up.
    const onBlur = () => {
      spaceHeld.current = false;
      hand = null;
      armed = null;
      pinch = null;
      down.clear();
      setGrab(restingGrab());
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('pointerdown', onPointerDown, true);
    node.addEventListener('pointermove', onPointerMove, true);
    node.addEventListener('pointerup', onPointerUp, true);
    node.addEventListener('pointercancel', onPointerUp, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('pointerdown', onPointerDown, true);
      node.removeEventListener('pointermove', onPointerMove, true);
      node.removeEventListener('pointerup', onPointerUp, true);
      node.removeEventListener('pointercancel', onPointerUp, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      setGrab('');
    };
  }, [frame, host]);

  // The open hand has to appear the moment the picture becomes draggable, and
  // that can happen with no pointer involved at all — the zoom bar, a keystroke,
  // or a window resize that changed what fits. A drag in progress owns the
  // cursor and is left alone.
  useEffect(() => {
    const node = host.current;
    if (!node || node.dataset.grab === 'active') return;
    if (magnified && (panOnDrag || spaceHeld.current)) node.dataset.grab = 'ready';
    else delete node.dataset.grab;
  }, [host, magnified, panOnDrag]);
}

/** Whether a key belongs to something being typed into rather than to the stage. */
export function isTyping(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node || typeof node.tagName !== 'string') return false;
  const tag = node.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable;
}
