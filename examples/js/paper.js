/**
 * paper.js
 *
 * The paper grain and vignette that sit over the map.
 *
 * Generated into a canvas rather than written as a CSS filter, for one
 * practical reason: the PNG export has to reproduce exactly what is on screen,
 * and an SVG `feTurbulence` background is not something you can draw into an
 * export canvas. One tile, made once, used by both.
 */

const TILE = 160;
let tile = null;

/**
 * A seamless noise tile. Cached - it is the same for every caller.
 *
 * @param {number} [strength=18] peak deviation from mid-grey, 0-127
 * @returns {HTMLCanvasElement}
 */
export function grainTile(strength = 18) {
  if (tile) return tile;

  tile = document.createElement('canvas');
  tile.width = TILE;
  tile.height = TILE;
  const ctx = tile.getContext('2d');
  const image = ctx.createImageData(TILE, TILE);
  const data = image.data;

  for (let i = 0; i < data.length; i += 4) {
    // Grey noise in the alpha channel: multiplied over the map, it darkens
    // unevenly like fibre in laid paper.
    const n = (Math.random() + Math.random() + Math.random()) / 3; // ~gaussian
    const v = Math.round((n - 0.5) * 2 * strength);
    data[i] = data[i + 1] = data[i + 2] = 0;
    data[i + 3] = Math.max(0, v);
  }
  ctx.putImageData(image, 0, 0);
  return tile;
}

/**
 * Point an element's background at the grain tile.
 *
 * @param {HTMLElement} element
 * @param {number} [strength]
 */
export function applyGrain(element, strength) {
  element.style.backgroundImage = `url(${grainTile(strength).toDataURL()})`;
  element.style.backgroundRepeat = 'repeat';
}

/**
 * Paint the grain over a context, tiled.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width  device px
 * @param {number} height device px
 * @param {number} [opacity=0.5] must match the on-screen layer's opacity
 */
export function drawGrain(ctx, width, height, opacity = 0.5) {
  const pattern = ctx.createPattern(grainTile(), 'repeat');
  if (!pattern) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/**
 * Paint the corner darkening over a context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width  device px
 * @param {number} height device px
 */
export function drawVignette(ctx, width, height) {
  const radius = Math.max(width, height) * 0.75;
  const gradient = ctx.createRadialGradient(
    width / 2,
    height * 0.45,
    radius * 0.55,
    width / 2,
    height * 0.45,
    radius
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(60,45,20,0.22)');
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
