/**
 * Drawing text layers into pixels.
 *
 * Type is rasterised by the browser rather than turned into geometry: the text
 * shaping a caption needs — Japanese line composition, combining marks, emoji —
 * is work the platform already does correctly, and a hand-rolled glyph
 * positioner would get it wrong in exactly the languages that matter here.
 *
 * Every size in a layer is a fraction of the frame's short edge, so the same
 * caption lands in the same place at proxy size, at full size, and in each tile
 * of a split export.
 */

import type { TextLayer } from '../recipe/schema';
import { fontStack } from './fonts';

/** True when a layer would put nothing on screen and can be skipped entirely. */
export function isLayerVisible(layer: TextLayer): boolean {
  return layer.content.trim().length > 0 && layer.opacity > 0.001;
}

/**
 * Cache key for a rasterised set of layers at one size.
 *
 * The size is part of it because the raster is resolution-specific: the preview
 * canvas, the export and each tile all ask for different pixels from the same
 * layers.
 */
export function textSignature(layers: readonly TextLayer[], width: number, height: number): string {
  const visible = layers.filter(isLayerVisible);
  if (visible.length === 0) return 'none';
  return `${width}x${height}:${JSON.stringify(visible)}`;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  width: number,
  height: number,
): void {
  const short = Math.min(width, height);
  const size = layer.size * short;
  const lines = layer.content.split('\n');
  const lineHeight = size * layer.lineHeight;

  ctx.save();
  ctx.translate(layer.x * width, layer.y * height);
  ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.globalAlpha = layer.opacity;
  ctx.font = `${layer.weight} ${size}px ${fontStack(layer.font)}`;
  ctx.textAlign = layer.align;
  ctx.textBaseline = 'middle';
  // Letter spacing arrived in canvas late enough that it is worth not assuming.
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${layer.tracking}em`;

  const top = -((lines.length - 1) * lineHeight) / 2;
  const anchor = layer.align === 'left' ? 0 : layer.align === 'right' ? -1 : -0.5;

  if (layer.background > 0.001) {
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const padX = size * 0.35;
    const padY = size * 0.28;
    ctx.fillStyle = hexToRgba(layer.backgroundColor, layer.background);
    ctx.fillRect(
      anchor * widest - padX,
      top - lineHeight / 2 - padY,
      widest + padX * 2,
      lineHeight * lines.length + padY * 2,
    );
  }

  if (layer.shadow > 0.001) {
    ctx.shadowColor = `rgba(0, 0, 0, ${layer.shadow})`;
    ctx.shadowBlur = size * 0.18;
    ctx.shadowOffsetY = size * 0.06;
  }

  if (layer.outline > 0.001) {
    // Stroking under the fill rather than over it keeps the outline outside the
    // glyph: a centred stroke drawn on top eats into thin strokes until the
    // letterforms close up.
    ctx.strokeStyle = layer.outlineColor;
    ctx.lineWidth = layer.outline * size * 2;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    for (const [i, line] of lines.entries()) ctx.strokeText(line, 0, top + i * lineHeight);
    ctx.shadowColor = 'transparent';
  }

  ctx.fillStyle = layer.color;
  for (const [i, line] of lines.entries()) ctx.fillText(line, 0, top + i * lineHeight);
  ctx.restore();
}

/**
 * Rasterise every visible layer at the given size.
 *
 * Returns null when there is nothing to draw, so the compositing step can be
 * skipped rather than blending a fully transparent texture over every pixel.
 */
export function rasterizeText(
  layers: readonly TextLayer[],
  width: number,
  height: number,
): Uint8ClampedArray | null {
  const visible = layers.filter(isLayerVisible);
  if (visible.length === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  for (const layer of visible) drawLayer(ctx, layer, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}
