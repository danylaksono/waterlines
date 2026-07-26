/**
 * bounds.js
 *
 * Affine-transform utilities used by the engine: comparing transforms (to skip
 * redundant frames) and inverting one to find which slice of mercator space is
 * on screen (to cull rings).
 */

/**
 * True when two transforms are close enough that redrawing would be a no-op.
 *
 * @param {import('./WaterlineRenderer.js').Affine|null} m1
 * @param {import('./WaterlineRenderer.js').Affine|null} m2
 * @param {number} [epsilon=1e-4]
 * @returns {boolean}
 */
export function affineEquals(m1, m2, epsilon = 1e-4) {
  if (!m1 || !m2) return false;
  return (
    Math.abs(m1.a - m2.a) < epsilon &&
    Math.abs(m1.b - m2.b) < epsilon &&
    Math.abs(m1.c - m2.c) < epsilon &&
    Math.abs(m1.d - m2.d) < epsilon &&
    Math.abs(m1.e - m2.e) < epsilon &&
    Math.abs(m1.f - m2.f) < epsilon
  );
}

/**
 * Mercator-space bbox of a padded screen rectangle, by inverting the affine.
 *
 * The padding must be at least the ripple extent: a ring can be off screen and
 * still throw waterlines into view.
 *
 * @param {import('./WaterlineRenderer.js').Affine} m
 * @param {number} width  CSS px
 * @param {number} height CSS px
 * @param {number} [pad=0] CSS px on every side
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}}
 */
export function mercatorBounds(m, width, height, pad = 0) {
  const det = m.a * m.d - m.c * m.b;
  if (!det) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };

  const corners = [
    [-pad, -pad],
    [width + pad, -pad],
    [width + pad, height + pad],
    [-pad, height + pad],
  ];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [sx, sy] of corners) {
    const qx = sx - m.e;
    const qy = sy - m.f;
    const u = (m.d * qx - m.c * qy) / det;
    const v = (-m.b * qx + m.a * qy) / det;
    if (u < minX) minX = u;
    if (u > maxX) maxX = u;
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  }
  return { minX, minY, maxX, maxY };
}
