// @vitest-environment happy-dom

import { act, createElement, type ReactElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resizeCrop } from '../src/core/geometry/transform';
import { isTyping, PAN_THRESHOLD, useStageGestures } from '../src/ui/gestures';
import { FIT_VIEW, type View } from '../src/ui/view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function input(type: string): HTMLInputElement {
  const node = document.createElement('input');
  node.type = type;
  return node;
}

describe('which targets take text entry', () => {
  it('is true for the fields that take text', () => {
    for (const type of ['text', 'search', 'number', 'email', 'password', 'url']) {
      expect(isTyping(input(type)), type).toBe(true);
    }
    expect(isTyping(document.createElement('textarea'))).toBe(true);
    expect(isTyping(document.createElement('select'))).toBe(true);
  });

  it('is false for the inputs that take none, so the stage keys stay live', () => {
    for (const type of ['range', 'checkbox', 'radio', 'color', 'button', 'file']) {
      expect(isTyping(input(type)), type).toBe(false);
    }
    expect(isTyping(document.createElement('button'))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

const ZOOMED: View = { ...FIT_VIEW, zoom: 3 };

interface Harness {
  stage: HTMLElement;
  child: HTMLElement;
  seen: string[];
  onPanStart: ReturnType<typeof vi.fn>;
}

let root: Root;
let mount: HTMLElement;

beforeEach(() => {
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
});

afterEach(() => {
  act(() => root.unmount());
  mount.remove();
});

function render(): Harness {
  const onPanStart = vi.fn();
  const seen: string[] = [];
  function Probe(): ReactElement {
    const host = useRef<HTMLDivElement | null>(null);
    const frame = useRef<HTMLDivElement | null>(null);
    useStageGestures({
      host,
      frame,
      view: ZOOMED,
      fitScale: 1,
      enabled: true,
      panOnDrag: true,
      onView: () => {},
      onPanStart,
    });
    const record = (e: { type: string; pointerId?: number }) => {
      seen.push(`${e.type}:${e.pointerId}`);
    };
    return createElement(
      'div',
      { ref: host, id: 'stage' },
      createElement('div', {
        ref: frame,
        id: 'child',
        onPointerDown: record,
        onPointerMove: record,
        onPointerUp: record,
      }),
    );
  }
  act(() => root.render(createElement(Probe)));
  return {
    stage: mount.querySelector('#stage') as HTMLElement,
    child: mount.querySelector('#child') as HTMLElement,
    seen,
    onPanStart,
  };
}

function touch(target: HTMLElement, type: string, id: number, x = 0, y = 0) {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: id,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
      }),
    );
  });
}

describe('a pinch', () => {
  it('takes the gesture off the tool the first finger started, whichever finger lifts first', () => {
    for (const order of [
      [1, 2],
      [2, 1],
    ] as const) {
      const h = render();
      touch(h.child, 'pointerdown', 1, 10, 10);
      touch(h.child, 'pointerdown', 2, 60, 10);
      expect(h.onPanStart).toHaveBeenCalled();
      h.seen.length = 0;
      touch(h.child, 'pointermove', 1, 12, 10);
      touch(h.child, 'pointerup', order[0]);
      touch(h.child, 'pointermove', order[1], 30, 30);
      touch(h.child, 'pointerup', order[1]);
      expect(h.seen, order.join()).toEqual([]);
      act(() => root.render(createElement('div')));
    }
  });

  it('lets the next, single press through again', () => {
    const h = render();
    touch(h.child, 'pointerdown', 1);
    touch(h.child, 'pointerdown', 2, 50, 0);
    touch(h.child, 'pointerup', 1);
    touch(h.child, 'pointerup', 2);
    h.seen.length = 0;
    touch(h.child, 'pointerdown', 3);
    touch(h.child, 'pointerup', 3);
    expect(h.seen).toEqual(['pointerdown:3', 'pointerup:3']);
  });

  it('keeps a press that stays under the pan threshold a tap', () => {
    const h = render();
    touch(h.child, 'pointerdown', 1);
    touch(h.child, 'pointermove', 1, PAN_THRESHOLD - 1, 0);
    touch(h.child, 'pointerup', 1);
    expect(h.seen).toEqual(['pointerdown:1', 'pointermove:1', 'pointerup:1']);
    expect(h.onPanStart).not.toHaveBeenCalled();
  });
});

function key(target: EventTarget, type: string, code: string): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, code, key: code });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('the space bar as the hand', () => {
  it('does not press the focused button, on the way down or up', () => {
    render();
    const button = document.createElement('button');
    document.body.append(button);
    expect(key(button, 'keydown', 'Space').defaultPrevented).toBe(true);
    expect(key(button, 'keyup', 'Space').defaultPrevented).toBe(true);
    button.remove();
  });

  it('still works with a slider focused, and leaves a text field its spaces', () => {
    render();
    const slider = input('range');
    const text = input('text');
    document.body.append(slider, text);
    expect(key(slider, 'keydown', 'Space').defaultPrevented).toBe(true);
    expect(key(text, 'keydown', 'Space').defaultPrevented).toBe(false);
    slider.remove();
    text.remove();
  });
});

describe('resizing the crop past the frame', () => {
  const start = { x: 0.2, y: 0.3, w: 0.4, h: 0.3 };
  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
  const reaches = [-2, -0.5, 0, 0.5, 1, 1.5, 3];

  it('leaves the edges the handle does not own where they were', () => {
    for (const ratio of [null, 1, 0.6]) {
      for (const handle of handles) {
        for (const px of reaches) {
          for (const py of reaches) {
            const r = resizeCrop(start, handle, px, py, ratio);
            const where = `${handle} ${px},${py} ratio ${ratio}`;
            expect(r.x, where).toBeGreaterThanOrEqual(-1e-9);
            expect(r.y, where).toBeGreaterThanOrEqual(-1e-9);
            expect(r.x + r.w, where).toBeLessThanOrEqual(1 + 1e-9);
            expect(r.y + r.h, where).toBeLessThanOrEqual(1 + 1e-9);
            if (ratio !== null) continue;
            if (!handle.includes('w')) expect(r.x, where).toBeCloseTo(start.x, 9);
            if (!handle.includes('e')) expect(r.x + r.w, where).toBeCloseTo(start.x + start.w, 9);
            if (!handle.includes('n')) expect(r.y, where).toBeCloseTo(start.y, 9);
            if (!handle.includes('s')) expect(r.y + r.h, where).toBeCloseTo(start.y + start.h, 9);
          }
        }
      }
    }
  });
});

describe('the compare key', () => {
  async function mountStage() {
    const { Stage } = await import('../src/ui/components/Stage');
    const { I18nProvider } = await import('../src/i18n');
    const onCompare = vi.fn();
    const props = {
      canvasRef: { current: null },
      viewportRef: { current: null },
      hasImage: true,
      comparing: false,
      tool: 'adjust',
      view: FIT_VIEW,
      fitScale: 1,
      overlay: null,
      onCompare,
      onView: () => {},
      onResetView: () => {},
      onFiles: () => {},
      onPick: () => {},
      onHelp: () => {},
    };
    // biome-ignore lint/suspicious/noExplicitAny: the tool name is all the stage reads of it
    act(() => root.render(createElement(I18nProvider, null, createElement(Stage, props as any))));
    return onCompare;
  }

  it('is not started by typing a backslash, and is released when the window loses focus', async () => {
    const onCompare = await mountStage();
    const text = input('text');
    document.body.append(text);
    act(() => {
      text.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: '\\' }));
    });
    expect(onCompare).not.toHaveBeenCalled();
    text.remove();

    const body = document.body;
    const down = new KeyboardEvent('keydown', { bubbles: true, key: '\\' });
    act(() => {
      body.dispatchEvent(down);
    });
    expect(onCompare).toHaveBeenLastCalledWith(true);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onCompare).toHaveBeenLastCalledWith(false);
  });
});
