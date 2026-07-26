/**
 * still.js
 *
 * Render waterlines to a standalone canvas, with no map involved - the
 * original notebook use case: fit some geometry to a box and draw it.
 *
 * Handy for thumbnails, print figures, and for checking a style without
 * spinning up a map.
 */

import { geojsonToRings, ringsBbox } from './core/rings.js';
import { simplifyRings } from './core/simplify.js';
import { appendRingsToPath } from './core/path.js';
import { WaterlineRenderer } from './render/WaterlineRenderer.js';

/**
 * @param {Object|import('./core/rings.js').Ring[]} data GeoJSON or rings
 * @param {Object} [options]
 * @param {number} [options.width=600] CSS px
 * @param {number} [options.height=600] CSS px
 * @param {number} [options.padding] px of margin; defaults to the ripple extent
 * @param {Partial<import('./render/style.js').WaterlineStyle> & {preset?:string}} [options.style]
 * @param {number} [options.pixelRatio=1]
 * @param {HTMLCanvasElement} [options.canvas] draw into this canvas instead of a new one
 * @param {'catmullRom'|'linear'} [options.curve='catmullRom']
 * @param {number} [options.alpha=0.5]
 * @param {number} [options.tolerancePx=0.4]
 * @returns {HTMLCanvasElement}
 */
export function renderStill(data, options = {}) {
  const {
    width = 600,
    height = 600,
    pixelRatio = 1,
    curve = 'catmullRom',
    alpha = 0.5,
    tolerancePx = 0.4,
  } = options;

  const renderer = new WaterlineRenderer(options.style);
  const padding = options.padding ?? renderer.style.extent + 8;

  const rings = Array.isArray(data) ? data : geojsonToRings(data);
  if (!rings.length) throw new Error('renderStill: no polygons in the input');

  const bbox = ringsBbox(rings);
  const spanX = Math.max(bbox.maxX - bbox.minX, 1e-9);
  const spanY = Math.max(bbox.maxY - bbox.minY, 1e-9);
  const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY);

  const matrix = {
    a: scale,
    b: 0,
    c: 0,
    d: scale,
    e: (width - (bbox.minX + bbox.maxX) * scale) / 2,
    f: (height - (bbox.minY + bbox.maxY) * scale) / 2,
  };

  const simplified = simplifyRings(rings, tolerancePx / scale, 1 / scale);
  const path = new Path2D();
  appendRingsToPath(path, simplified, scale, { curve, alpha });

  const canvas = options.canvas || document.createElement('canvas');
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  renderer.draw(ctx, {
    path,
    refWorldSize: scale,
    matrix,
    width,
    height,
    pixelRatio,
  });

  return canvas;
}
