import { describe, expect, it } from 'vitest';
import { requestTokens } from '../src/ui/useEditor';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** The shape `openFiles` has: issue, await the decode, land only if still current. */
function opener() {
  const tokens = requestTokens<'photo' | 'reference'>();
  const landed: string[] = [];
  const failed: string[] = [];
  const open = (decode: Promise<string>) => {
    const ticket = tokens.issue('photo');
    return (async () => {
      try {
        const name = await decode;
        if (!tokens.isCurrent('photo', ticket)) return;
        landed.push(name);
      } catch (err) {
        if (!tokens.isCurrent('photo', ticket)) return;
        failed.push(String(err));
      }
    })();
  };
  return { tokens, landed, failed, open };
}

describe('overlapping opens', () => {
  it('keeps the photo opened last when the first decode finishes later', async () => {
    const { landed, open } = opener();
    const slow = deferred<string>();
    const fast = deferred<string>();
    const first = open(slow.promise);
    const second = open(fast.promise);
    fast.resolve('second.jpg');
    await second;
    slow.resolve('first.heic');
    await first;
    expect(landed).toEqual(['second.jpg']);
  });

  it('drops a superseded failure instead of reporting it', async () => {
    const { landed, failed, open } = opener();
    const slow = deferred<string>();
    const fast = deferred<string>();
    const first = open(slow.promise);
    const second = open(fast.promise);
    fast.resolve('second.jpg');
    slow.reject(new Error('unsupported'));
    await Promise.all([first, second]);
    expect(landed).toEqual(['second.jpg']);
    expect(failed).toEqual([]);
  });

  it('lets the newest request report its own failure', async () => {
    const { failed, open } = opener();
    await open(Promise.reject(new Error('unsupported')));
    expect(failed).toHaveLength(1);
  });

  it('keeps a photo and a reference from superseding each other', () => {
    const tokens = requestTokens<'photo' | 'reference'>();
    const photo = tokens.issue('photo');
    const reference = tokens.issue('reference');
    expect(tokens.isCurrent('photo', photo)).toBe(true);
    expect(tokens.isCurrent('reference', reference)).toBe(true);
    tokens.issue('photo');
    expect(tokens.isCurrent('photo', photo)).toBe(false);
    expect(tokens.isCurrent('reference', reference)).toBe(true);
  });
});
