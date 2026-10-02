/**
 * Shrink a size so its long edge is at most `longEdge`, keeping its shape.
 *
 * Never enlarges: a size already within the edge comes back as it was, so a
 * bitmap derived from it never holds more pixels than the photograph has.
 */
export function fitLongEdge(width: number, height: number, longEdge: number): [number, number] {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}
