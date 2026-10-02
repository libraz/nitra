/**
 * A WebGL2 context with no GPU behind it.
 *
 * Every constant is a stable number, every call that creates an object hands
 * back a fresh token, and the textures and framebuffers still alive are
 * counted. That is enough to run the renderer's TypeScript — its bookkeeping,
 * its cache, its error paths — and nothing it draws means anything.
 */

export interface FakeGl {
  gl: WebGL2RenderingContext;
  /** Textures created and not yet deleted. */
  textures: Set<object>;
  /** Framebuffers created and not yet deleted. */
  framebuffers: Set<object>;
  /** Calls to replace for the next few invocations, by method name. */
  fail: Map<string, () => unknown>;
  /** Every call made, by method name. */
  calls: string[];
  /** The last value each uniform was set to, by name. */
  uniforms: Map<string, unknown[]>;
  /** Fills each `readPixels` destination; left as zeros when unset. */
  onRead: ((width: number, height: number, out: Uint8Array) => void) | null;
}

export function fakeGl(): FakeGl {
  const textures = new Set<object>();
  const framebuffers = new Set<object>();
  const fail = new Map<string, () => unknown>();
  const calls: string[] = [];
  const uniforms = new Map<string, unknown[]>();
  const constants = new Map<string, number>();
  const constant = (name: string): number => {
    let value = constants.get(name);
    if (value === undefined) {
      value = 0x8000 + constants.size;
      constants.set(name, value);
    }
    return value;
  };
  const fields: Record<string, unknown> = { drawingBufferColorSpace: 'srgb' };
  const fake = { textures, framebuffers, fail, calls, uniforms, onRead: null } as unknown as FakeGl;

  const methods: Record<string, (...args: unknown[]) => unknown> = {
    createTexture: () => {
      const texture = {};
      textures.add(texture);
      return texture;
    },
    deleteTexture: (texture) => textures.delete(texture as object),
    createFramebuffer: () => {
      const framebuffer = {};
      framebuffers.add(framebuffer);
      return framebuffer;
    },
    deleteFramebuffer: (framebuffer) => framebuffers.delete(framebuffer as object),
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getExtension: () => ({}),
    getParameter: () => 16384,
    createShader: () => ({}),
    createProgram: () => ({}),
    createVertexArray: () => ({}),
    getUniformLocation: (_program, name) => ({ name }),
    readPixels: (_x, _y, width, height, _format, _type, out) =>
      fake.onRead?.(width as number, height as number, out as Uint8Array),
  };

  const gl = new Proxy(
    {},
    {
      has(_target, prop) {
        return typeof prop === 'string' && prop in fields;
      },
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop in fields) return fields[prop];
        if (/^[A-Z0-9_]+$/.test(prop)) return constant(prop);
        return (...args: unknown[]) => {
          calls.push(prop);
          if (prop.startsWith('uniform')) {
            const location = args[0] as { name?: string } | null;
            if (location?.name) uniforms.set(location.name, args.slice(1));
          }
          const override = fail.get(prop);
          if (override) {
            fail.delete(prop);
            return override();
          }
          return methods[prop]?.(...args);
        };
      },
      set(_target, prop, value) {
        if (typeof prop === 'string') fields[prop] = value;
        return true;
      },
    },
  ) as WebGL2RenderingContext;

  fake.gl = gl;
  return fake;
}

/** A canvas that hands out the fake context. */
export function fakeCanvas(gl: WebGL2RenderingContext): HTMLCanvasElement {
  return {
    width: 300,
    height: 150,
    style: {},
    getContext: () => gl,
  } as unknown as HTMLCanvasElement;
}
