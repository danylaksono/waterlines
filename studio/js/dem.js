/**
 * dem.js
 *
 * Elevation, as a plain grid of screen-aligned samples.
 *
 * Hachures need a surface, and the studio had no elevation data at all, so this
 * fetches it: the Terrain Tiles on AWS Open Data, in Mapzen's `terrarium`
 * encoding, which packs metres into an ordinary PNG as
 *
 *     h = R * 256 + G + B / 256 - 32768
 *
 * Two properties of that dataset are what make it usable here rather than
 * merely available. It is served with `Access-Control-Allow-Origin: *`, so the
 * tiles can be drawn into a canvas and read back with `getImageData` - and,
 * crucially, without tainting it, which is what would otherwise break the PNG
 * export three files away. And it carries bathymetry, so ocean is genuinely
 * negative rather than a nodata hole: testing `h > 0` gives a coastline for
 * free, and the hachures stop exactly where the waterlines begin.
 *
 * The grid this hands back is in *screen* space, not in tile space. That is
 * the whole trick of the file. Sampling on a screen-aligned lattice means the
 * gradient computed from it is already a screen-space gradient, so the map's
 * bearing needs no special handling anywhere downstream - rotate the map and
 * the fall lines rotate with it, because the lattice did.
 */

import { metersPerMercatorUnit, worldSize } from '../../src/core/mercator.js';

/** Mapzen terrarium tiles, hosted by the AWS Open Data programme. */
const TILE_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** Attribution the dataset asks for, shown under the basemap picker. */
export const DEM_ATTRIBUTION =
  '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles</a> ' +
  'on AWS Open Data (SRTM, NED, and others)';

const TILE = 256;

/** The dataset's own limit; asking beyond it returns nothing. */
const MAX_DEM_ZOOM = 15;

/**
 * Decoded tiles, keyed `z/x/y`. A tile is a quarter of a megabyte as a
 * Float32Array, so this is a 30 MB ceiling - enough that panning back and
 * forth across a few screens costs no network at all, and small enough not to
 * hold a whole session's browsing in memory.
 */
const CACHE_LIMIT = 120;
const cache = new Map();
const inflight = new Map();

/** Decoded tiles carry no elevation; `null` stands for "sea, or nothing". */
function remember(key, tile) {
  cache.set(key, tile);
  if (cache.size > CACHE_LIMIT) {
    // Map iterates in insertion order, so the first key is the oldest.
    cache.delete(cache.keys().next().value);
  }
  return tile;
}

/**
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {Promise<Float32Array|null>} metres per pixel, row-major, or null
 *   when the tile is outside the world or the server has none
 */
function loadTile(z, x, y) {
  const n = 1 << z;
  if (y < 0 || y >= n) return Promise.resolve(null);
  // Wrap longitudinally, so a view spanning the antimeridian still resolves.
  const wrapped = ((x % n) + n) % n;

  const key = `${z}/${wrapped}/${y}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (inflight.has(key)) return inflight.get(key);

  const url = TILE_URL.replace('{z}', z).replace('{x}', wrapped).replace('{y}', y);
  const promise = new Promise((resolve) => {
    const image = new Image();
    // Required for `getImageData` to be allowed, and for the export canvas to
    // stay untainted. Without it the tile still draws and the PNG still looks
    // right on screen, but `toBlob` throws a security error.
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(remember(key, decode(image)));
    image.onerror = () => resolve(remember(key, null));
    image.src = url;
  }).finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

/** @param {HTMLImageElement} image @returns {Float32Array} */
function decode(image) {
  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, TILE, TILE);
  const { data } = ctx.getImageData(0, 0, TILE, TILE);

  const out = new Float32Array(TILE * TILE);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
  }
  return out;
}

// --------------------------------------------------------------------------
// screen-space sampling
// --------------------------------------------------------------------------

/**
 * Invert the mercator-to-screen affine, so a pixel can be asked where on the
 * globe it is without a `map.unproject` call per sample.
 *
 * @param {import('../../src/render/WaterlineRenderer.js').Affine} m
 */
function invert(m) {
  const det = m.a * m.d - m.c * m.b;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/**
 * DEM zoom whose pixels land roughly one-to-one on the sample lattice.
 *
 * The map's world is `512 * 2^zoom` px across and a DEM level's is
 * `256 * 2^z`, so matching a sample every `step` screen pixels to one DEM
 * pixel gives `z = zoom + 1 - log2(step)`. Asking for more detail than that
 * only feeds the blur; asking for less shows as terracing along the fall
 * lines, because the strokes follow the DEM's own stair-steps.
 *
 * @param {number} zoom map zoom
 * @param {number} step sample spacing, screen px
 * @returns {number}
 */
export function demZoomFor(zoom, step) {
  const wanted = Math.round(zoom + 1 - Math.log2(step));
  return Math.max(0, Math.min(MAX_DEM_ZOOM, wanted));
}

/**
 * @typedef {Object} HeightField
 * @property {Float32Array} height metres, row-major, `cols * rows`
 * @property {number} cols
 * @property {number} rows
 * @property {number} step sample spacing in screen CSS px
 * @property {number} groundStep sample spacing in ground metres
 * @property {number} demZoom the level actually fetched
 * @property {number} tiles tiles the field was stitched from
 * @property {number} missing how many of those came back empty
 */

/**
 * Build a height field covering a screen rectangle.
 *
 * The rectangle runs from `(-pad, -pad)` to `(width + pad, height + pad)` in
 * screen CSS px, matching the padded bitmap the hachure layer draws into.
 *
 * @param {Object} spec
 * @param {import('../../src/render/WaterlineRenderer.js').Affine} spec.matrix
 *   normalised mercator to screen
 * @param {number} spec.width  viewport CSS px
 * @param {number} spec.height viewport CSS px
 * @param {number} spec.pad    margin around the viewport, CSS px
 * @param {number} spec.step   sample spacing, CSS px
 * @param {number} spec.lat    view-centre latitude, for the metre scale
 * @param {number} [spec.maxTiles=48] cap on the fetch; the level drops until
 *   the view fits, which is what keeps a zoomed-out view from asking for
 *   thousands of tiles
 * @param {() => boolean} [spec.cancelled] polled after the fetch
 * @returns {Promise<HeightField|null>} null if cancelled
 */
export async function sampleHeightField(spec) {
  const {
    matrix,
    width,
    height,
    pad,
    step,
    lat,
    maxTiles = 48,
    cancelled = () => false,
  } = spec;

  const cols = Math.ceil((width + 2 * pad) / step) + 1;
  const rows = Math.ceil((height + 2 * pad) / step) + 1;

  const inverse = invert(matrix);
  const toMercator = (x, y) => [
    inverse.a * x + inverse.c * y + inverse.e,
    inverse.b * x + inverse.d * y + inverse.f,
  ];

  // Screen pixels per unit of normalised mercator, i.e. the map's world size.
  const scale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.c * matrix.b));
  const zoom = Math.log2(scale / 512);

  // The corners are enough for a bounding box even under rotation: an affine
  // maps the rectangle to a parallelogram, whose extent is its corners'.
  const corners = [
    toMercator(-pad, -pad),
    toMercator(width + pad, -pad),
    toMercator(width + pad, height + pad),
    toMercator(-pad, height + pad),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const bbox = [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ];

  let demZoom = demZoomFor(zoom, step);
  let range = tileRange(bbox, demZoom);
  while (demZoom > 0 && range.count > maxTiles) {
    demZoom--;
    range = tileRange(bbox, demZoom);
  }

  const keys = [];
  for (let ty = range.y0; ty <= range.y1; ty++) {
    for (let tx = range.x0; tx <= range.x1; tx++) keys.push([tx, ty]);
  }
  const loaded = await Promise.all(keys.map(([tx, ty]) => loadTile(demZoom, tx, ty)));
  if (cancelled()) return null;

  const tiles = new Map();
  let missing = 0;
  keys.forEach(([tx, ty], i) => {
    if (!loaded[i]) missing++;
    tiles.set(`${tx},${ty}`, loaded[i]);
  });

  // Global DEM pixel coordinates: the whole world is `TILE * 2^z` px across.
  const worldPx = TILE * Math.pow(2, demZoom);
  const n = 1 << demZoom;

  /** Elevation at a global DEM pixel, or 0 where there is no tile. */
  const pixel = (gx, gy) => {
    if (gy < 0 || gy >= worldPx) return 0;
    const wx = ((gx % worldPx) + worldPx) % worldPx;
    const tx = ((Math.floor(wx / TILE) % n) + n) % n;
    const ty = Math.floor(gy / TILE);
    const tile = tiles.get(`${tx},${ty}`);
    if (!tile) return 0;
    return tile[(gy - ty * TILE) * TILE + (wx - Math.floor(wx / TILE) * TILE)];
  };

  const out = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const sy = -pad + j * step;
    for (let i = 0; i < cols; i++) {
      const sx = -pad + i * step;
      const mx = inverse.a * sx + inverse.c * sy + inverse.e;
      const my = inverse.b * sx + inverse.d * sy + inverse.f;

      // Bilinear, because the DEM is usually being stretched: at the levels
      // hachures look right on, one DEM pixel spans a few screen pixels, and
      // nearest-neighbour puts visible stair-steps into every stroke.
      const gx = mx * worldPx - 0.5;
      const gy = my * worldPx - 0.5;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;

      const h00 = pixel(x0, y0);
      const h10 = pixel(x0 + 1, y0);
      const h01 = pixel(x0, y0 + 1);
      const h11 = pixel(x0 + 1, y0 + 1);

      out[j * cols + i] =
        h00 * (1 - fx) * (1 - fy) +
        h10 * fx * (1 - fy) +
        h01 * (1 - fx) * fy +
        h11 * fx * fy;
    }
  }

  return {
    height: out,
    cols,
    rows,
    step,
    // One sample step in ground metres. The `cos(lat)` inside
    // `metersPerMercatorUnit` is what stops Mercator's vertical stretch from
    // reading as gentler terrain the further north you go.
    groundStep: (step / worldSize(zoom)) * metersPerMercatorUnit(lat),
    demZoom,
    tiles: keys.length,
    missing,
  };
}

/** Tiles covering a normalised-mercator bbox at one level. */
function tileRange(bbox, z) {
  const n = 1 << z;
  const x0 = Math.floor(bbox[0] * n);
  const x1 = Math.floor(bbox[2] * n);
  const y0 = Math.max(0, Math.floor(bbox[1] * n));
  const y1 = Math.min(n - 1, Math.floor(bbox[3] * n));
  return { x0, x1, y0, y1, count: (x1 - x0 + 1) * Math.max(0, y1 - y0 + 1) };
}
