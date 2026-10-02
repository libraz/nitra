/**
 * The render-target pool: what it keeps idle, what it deletes, and what a
 * failed allocation leaves behind.
 */

import { describe, expect, it } from 'vitest';
import { GlError, TexturePool } from '../src/core/render/gl';
import { fakeGl } from './gl-fake';

describe('idle targets', () => {
  it('deletes the idle targets of sizes nobody asked for since the last trim', () => {
    const fake = fakeGl();
    const pool = new TexturePool(fake.gl);
    const old = pool.acquire(4000, 3000);
    pool.release(old);
    pool.trim();
    // A new crop shape: the old size is not asked for again.
    const current = pool.acquire(3000, 3000);
    pool.release(current);
    pool.trim();
    expect(fake.textures.has(old.texture)).toBe(false);
    expect(fake.framebuffers.has(old.framebuffer)).toBe(false);
    expect(fake.textures.has(current.texture)).toBe(true);
    expect(pool.acquire(3000, 3000)).toBe(current);
  });

  it('never deletes a target that is in use', () => {
    const fake = fakeGl();
    const pool = new TexturePool(fake.gl);
    const held = pool.acquire(64, 64);
    pool.trim(false);
    pool.trim(false);
    expect(fake.textures.has(held.texture)).toBe(true);
    pool.release(held);
    pool.trim(false);
    expect(fake.textures.size).toBe(0);
    expect(fake.framebuffers.size).toBe(0);
  });

  it('holds idle memory bounded by the sizes in use however many have been seen', () => {
    const fake = fakeGl();
    const pool = new TexturePool(fake.gl);
    for (let width = 100; width < 150; width++) {
      pool.release(pool.acquire(width, 80));
      pool.release(pool.acquire(1024, 768));
      pool.trim();
    }
    expect(fake.textures.size).toBe(2);
  });
});

describe('a failed allocation', () => {
  it('deletes what it created and leaves the pool as it was', () => {
    const fake = fakeGl();
    const pool = new TexturePool(fake.gl);
    fake.fail.set('checkFramebufferStatus', () => 0);
    expect(() => pool.acquire(32, 32)).toThrow(GlError);
    expect(fake.textures.size).toBe(0);
    expect(fake.framebuffers.size).toBe(0);
    // Nothing was registered as live, so the next acquire allocates afresh.
    const next = pool.acquire(32, 32);
    pool.release(next);
    pool.trim(false);
    expect(fake.textures.size).toBe(0);
  });

  it('deletes the texture when the framebuffer could not be made', () => {
    const fake = fakeGl();
    const pool = new TexturePool(fake.gl);
    fake.fail.set('createFramebuffer', () => null);
    expect(() => pool.acquire(32, 32)).toThrow(/framebuffer/);
    expect(fake.textures.size).toBe(0);
  });
});
