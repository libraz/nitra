/**
 * WebGL2 plumbing: context, programs, render targets.
 *
 * Every intermediate buffer is RGBA16F. Eight bits per channel is enough to show
 * a photo and not enough to process one — a tone curve applied to an 8-bit
 * intermediate lays visible bands into skin and sky, and the banding is baked in
 * by the time the next stage sees it.
 */

import type { Mat3 } from '../color/matrix';

export interface RenderTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

export class GlError extends Error {}

/** Fullscreen triangle. Positions come from `gl_VertexID`, so there is no buffer. */
const VERTEX_SHADER = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new GlError('could not create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown error';
    gl.deleteShader(shader);
    throw new GlError(`shader compile failed: ${log}`);
  }
  return shader;
}

/** A linked program plus a cache of its uniform locations. */
export class Program {
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private unit = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly handle: WebGLProgram,
  ) {}

  static create(gl: WebGL2RenderingContext, fragment: string): Program {
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
    const handle = gl.createProgram();
    if (!handle) throw new GlError('could not create program');
    gl.attachShader(handle, vs);
    gl.attachShader(handle, fs);
    gl.linkProgram(handle);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(handle) ?? 'unknown error';
      gl.deleteProgram(handle);
      throw new GlError(`program link failed: ${log}`);
    }
    return new Program(gl, handle);
  }

  bind(): this {
    this.gl.useProgram(this.handle);
    this.unit = 0;
    return this;
  }

  private location(name: string): WebGLUniformLocation | null {
    let loc = this.uniforms.get(name);
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(this.handle, name);
      this.uniforms.set(name, loc);
    }
    return loc;
  }

  float(name: string, value: number): this {
    this.gl.uniform1f(this.location(name), value);
    return this;
  }

  int(name: string, value: number): this {
    this.gl.uniform1i(this.location(name), value);
    return this;
  }

  vec2(name: string, x: number, y: number): this {
    this.gl.uniform2f(this.location(name), x, y);
    return this;
  }

  vec3(name: string, x: number, y: number, z: number): this {
    this.gl.uniform3f(this.location(name), x, y, z);
    return this;
  }

  /** Set a `vec3[]` uniform from a flat triplet list. */
  vec3Array(name: string, values: Float32Array): this {
    this.gl.uniform3fv(this.location(name), values);
    return this;
  }

  /**
   * Set a `mat3` uniform from a row-major matrix.
   *
   * GLSL stores columns first, and the transpose flag is fixed at false in
   * WebGL, so the transposition happens here — the same way {@link mat3ToGlsl}
   * does it for the matrices that are compiled in.
   */
  mat3(name: string, m: Mat3): this {
    this.gl.uniformMatrix3fv(
      this.location(name),
      false,
      new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]),
    );
    return this;
  }

  /** Bind a texture to the next free unit and point `name` at it. */
  texture(name: string, texture: WebGLTexture): this {
    const unit = this.unit++;
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.uniform1i(this.location(name), unit);
    return this;
  }

  dispose(): void {
    this.gl.deleteProgram(this.handle);
  }
}

/**
 * Reuse of half-float render targets.
 *
 * Allocating a 12-megapixel RGBA16F target costs about 96MB and a stall; a
 * slider drag would otherwise do it on every frame.
 */
export class TexturePool {
  private readonly free = new Map<string, RenderTarget[]>();
  private readonly live = new Set<RenderTarget>();

  constructor(private readonly gl: WebGL2RenderingContext) {}

  acquire(width: number, height: number): RenderTarget {
    const key = `${width}x${height}`;
    const bucket = this.free.get(key);
    const reused = bucket?.pop();
    if (reused) {
      this.live.add(reused);
      return reused;
    }
    const target = this.allocate(width, height);
    this.live.add(target);
    return target;
  }

  release(target: RenderTarget): void {
    if (!this.live.delete(target)) return;
    const key = `${target.width}x${target.height}`;
    const bucket = this.free.get(key);
    if (bucket) bucket.push(target);
    else this.free.set(key, [target]);
  }

  private allocate(width: number, height: number): RenderTarget {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new GlError('could not create texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new GlError('could not create framebuffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new GlError(`half-float render target unavailable (status 0x${status.toString(16)})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer, width, height };
  }

  dispose(): void {
    const gl = this.gl;
    const all = [...this.live, ...[...this.free.values()].flat()];
    for (const t of all) {
      gl.deleteTexture(t.texture);
      gl.deleteFramebuffer(t.framebuffer);
    }
    this.free.clear();
    this.live.clear();
  }
}

export interface GlContext {
  gl: WebGL2RenderingContext;
  pool: TexturePool;
  /** Draw the fullscreen triangle into `target`, or the canvas when null. */
  draw(target: RenderTarget | null, width: number, height: number): void;
  dispose(): void;
}

/**
 * Create the rendering context.
 *
 * The drawing buffer is Display-P3 where the browser allows it. Falling back to
 * sRGB costs the wide-gamut colours an iPhone records, which is visible on the
 * saturated end of a photo, so the choice is reported rather than hidden.
 */
export function createGlContext(canvas: HTMLCanvasElement): GlContext & { wideGamut: boolean } {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new GlError('WebGL2 is not available in this browser');

  if (
    !gl.getExtension('EXT_color_buffer_half_float') &&
    !gl.getExtension('EXT_color_buffer_float')
  ) {
    throw new GlError('half-float render targets are not available in this browser');
  }
  gl.getExtension('OES_texture_float_linear');

  let wideGamut = false;
  try {
    gl.drawingBufferColorSpace = 'display-p3';
    wideGamut = gl.drawingBufferColorSpace === 'display-p3';
  } catch {
    wideGamut = false;
  }

  const vao = gl.createVertexArray();
  if (!vao) throw new GlError('could not create vertex array');
  gl.bindVertexArray(vao);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  const pool = new TexturePool(gl);

  return {
    gl,
    pool,
    wideGamut,
    draw(target, width, height) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
      gl.viewport(0, 0, width, height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      pool.dispose();
      gl.deleteVertexArray(vao);
    },
  };
}

/**
 * Upload 8-bit source pixels as a mipmapped sRGB-transfer texture.
 *
 * The mip chain is what makes the reductions honest. A twelve-megapixel photo
 * shown at a thousand pixels, or exported at the size a feed accepts, is being
 * minified by a factor of four or more, and a single bilinear tap at that ratio
 * samples a sixteenth of the pixels it should be averaging — which shows up as
 * shimmering hair and stair-stepped diagonals, and gets worse the moment the
 * frame is rotated off the axis.
 */
export function createSourceTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  data: Uint8ClampedArray,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new GlError('could not create source texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // SRGB8_ALPHA8 makes the hardware apply the transfer function on every fetch,
  // which is both free and more accurate than doing it in the shader — and it
  // means filtered samples are averaged in linear light.
  const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.SRGB8_ALPHA8, width, height);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    width,
    height,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  );
  if (levels > 1) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/**
 * Upload a rasterised text layer.
 *
 * Sampling is nearest-neighbour on purpose. The layer is drawn at exactly the
 * resolution it will be composited at, so every texel lands on one fragment;
 * filtering could only blur the edges the rasteriser already antialiased, and
 * interpolating an unpremultiplied colour against transparent black would put a
 * dark rim around every glyph.
 */
export function createTextTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  data: Uint8ClampedArray,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new GlError('could not create text texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.SRGB8_ALPHA8, width, height);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    width,
    height,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** Upload a tone curve as a single-channel lookup texture. */
export function createLutTexture(gl: WebGL2RenderingContext, lut: Float32Array): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new GlError('could not create LUT texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16F, lut.length, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, lut.length, 1, gl.RED, gl.FLOAT, lut);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}
