/**
 * rhumb.js
 *
 * The criss-crossing wind-rose network of a portolan chart, as MapLibre line
 * layers. Ported from the `rhumb-rose` lab, with two changes noted below.
 *
 * Two facts make this cheap:
 *
 *  1. The historical construction is ruler-and-compass. Mark 16 equidistant
 *     points on a hidden circle and join every point to every other; the chord
 *     from vertex j to vertex k has bearing `11.25 * (j + k) + 90`, always a
 *     multiple of 11.25 degrees. So the whole web is just "every line through a
 *     vertex whose bearing is a point of the 32-wind compass, clipped to the
 *     sheet" - 136 lines for one system.
 *  2. In Web Mercator a loxodrome is a straight line, and MapLibre draws a
 *     GeoJSON segment straight in projected space. So a two-point LineString is
 *     simultaneously a true constant-bearing rhumb and a straight line on
 *     screen: do the geometry with plain Euclidean maths in mercator, unproject
 *     at the end.
 *
 * Unlike the waterlines this is ordinary vector geometry, so it goes to the GPU
 * as a `line` layer rather than onto the 2D canvas - no per-frame cost, and the
 * PNG export picks it up for free because it composites the map canvas.
 *
 * Two departures from the lab:
 *
 *  - Geometry is in *normalised* mercator (0..1 over the world square, y down),
 *    the space the rest of this repo works in, rather than metres.
 *  - Lattice mode is the scale-free one: cells are quadtree cells and the level
 *    follows the zoom, so the weave holds its size on screen however far you go
 *    in, and only the cells in view are built. Tiling the whole world at one
 *    fixed radius - what the lab does - gives tens of thousands of roses at a
 *    small radius and a single rose once you zoom past it.
 */

import {
  latToMercatorY,
  lngToMercatorX,
  mercatorXToLng,
  mercatorYToLat,
  worldSize,
} from '../../src/core/mercator.js';

const D2R = Math.PI / 180;

/** The engraver's convention: principals in black, half-winds green, quarters red. */
export const HISTORICAL_INK = {
  principal: '#241c14',
  half: '#2f6b3a',
  quarter: '#a8291f',
};

/** Drawn quarters first so the principal winds sit on top, as on a chart. */
const ORDERS = ['quarter', 'half', 'principal'];

const SOURCE_ID = 'rhumb';
const LAYER_ID = { quarter: 'rhumb-quarter', half: 'rhumb-half', principal: 'rhumb-principal' };

const WIDTH = {
  quarter: ['interpolate', ['linear'], ['zoom'], 0, 0.35, 6, 0.6, 12, 0.9],
  half: ['interpolate', ['linear'], ['zoom'], 0, 0.4, 6, 0.75, 12, 1.1],
  principal: ['interpolate', ['linear'], ['zoom'], 0, 0.5, 6, 0.95, 12, 1.5],
};

const BASE_ALPHA = { quarter: 0.55, half: 0.65, principal: 0.8 };

/**
 * Lattice roses per axis. A rose is ~136 two-point lines, so this caps a
 * rebuild at ~13k features - enough to fill a 4K window at any radius the
 * slider offers, and small enough that regenerating on every `moveend` is not
 * something the user notices.
 */
const MAX_CELLS_PER_AXIS = 10;

/**
 * How wide a lattice cell wants to be on screen, per degree of the radius
 * control. The slider means real degrees for a single system; on the lattice
 * there is no one system to measure, so it reads as apparent size instead.
 *
 * Calibrated so the default radius puts about one system across the window -
 * the density a single rose has when its circle roughly fills the view, which
 * is the look a chart has. Packing the roses tighter than that is what the
 * lab's lattice preview does, and over a map it goes to a solid mesh.
 */
const LATTICE_PX_PER_DEGREE = 96;

// --------------------------------------------------------------------------
// geometry
// --------------------------------------------------------------------------

/** Direction of the i-th 32-wind point, in normalised mercator (y grows south). */
function direction(index) {
  const bearing = index * 11.25 * D2R;
  return [Math.sin(bearing), -Math.cos(bearing)];
}

function windOrder(index) {
  if (index % 4 === 0) return 'principal';
  return index % 2 === 0 ? 'half' : 'quarter';
}

/**
 * Clip the infinite line through (px, py) with direction (dx, dy) to a box.
 *
 * @returns {number[][]|null} two endpoints, or null if the line misses the box
 */
function clipLine(px, py, dx, dy, [xmin, ymin, xmax, ymax]) {
  let t0 = -Infinity;
  let t1 = Infinity;
  const edges = [
    [-dx, px - xmin],
    [dx, xmax - px],
    [-dy, py - ymin],
    [dy, ymax - py],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t0 >= t1 ? null : [[px + dx * t0, py + dy * t0], [px + dx * t1, py + dy * t1]];
}

/**
 * One hidden circle: 16 vertices, and through each of them every line whose
 * bearing is a compass point, clipped to `box`.
 *
 * Only the 16 directions are walked, not all 32 wind points: a bearing and its
 * reciprocal describe the same infinite line. Lines that come out collinear -
 * and many do, which is what makes the web look woven rather than tangled - are
 * emitted once, keyed by direction and perpendicular offset.
 *
 * @param {number} cx centre x, normalised mercator
 * @param {number} cy centre y, normalised mercator
 * @param {number} r circle radius in normalised mercator units
 * @param {number[]} box [xmin, ymin, xmax, ymax] to clip to
 * @param {{quarter?: boolean}} [options]
 * @returns {Object[]} GeoJSON LineString features
 */
export function windroseSystem(cx, cy, r, box, options = {}) {
  const { quarter = true } = options;

  const vertices = [];
  for (let k = 0; k < 16; k++) {
    const bearing = k * 22.5 * D2R;
    vertices.push([cx + r * Math.sin(bearing), cy - r * Math.cos(bearing)]);
  }

  // Distinct parallels of one system are ~0.1r apart, so quantising the
  // perpendicular offset a thousand times finer than that separates them
  // without letting float error split a line in two.
  const quantum = r * 1e-3;
  const features = [];
  const seen = new Set();

  for (const [vx, vy] of vertices) {
    for (let i = 0; i < 16; i++) {
      const order = windOrder(i);
      if (!quarter && order === 'quarter') continue;

      const [ux, uy] = direction(i);
      const perpendicular = vx * -uy + vy * ux;
      const key = `${i}:${Math.round(perpendicular / quantum)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const segment = clipLine(vx, vy, ux, uy, box);
      if (!segment) continue;

      features.push({
        type: 'Feature',
        properties: { wind_order: order, bearing: +(i * 11.25).toFixed(2) },
        geometry: {
          type: 'LineString',
          coordinates: segment.map(([x, y]) => [mercatorXToLng(x), mercatorYToLat(y)]),
        },
      });
    }
  }
  return features;
}

/**
 * @typedef {Object} RhumbOptions
 * @property {[number, number]} center rose centre, [lng, lat]
 * @property {number} radiusDeg hidden-circle radius, in degrees of longitude
 * @property {boolean} [quarter=true] include the sixteen quarter-winds
 * @property {boolean} [extend=true] run the lines past the circle to the sheet edge
 * @property {boolean} [lattice=false] repeat the system on a world-aligned grid
 * @property {number} [zoom=0] map zoom, which sets the lattice's quadtree level
 * @property {number[]} [view] [xmin, ymin, xmax, ymax] in normalised mercator;
 *   which cells a lattice fills. Defaults to the whole world.
 */

/**
 * Cell size for the lattice, in normalised mercator.
 *
 * Web Mercator is a quadtree: a cell of 2^-k is exactly one tile at zoom k, so
 * raising k by one per zoom level holds the cell at a constant size on screen -
 * the property that makes the lattice look identical at every scale, and the
 * reason every tile at a given zoom would hold the same geometry in local tile
 * coordinates. Snapping to a power of two is what buys that; it also means the
 * apparent size steps rather than sliding as you zoom.
 *
 * @param {number} radiusDeg the radius control
 * @param {number} zoom
 * @returns {number}
 */
export function latticeCell(radiusDeg, zoom) {
  const target = Math.max(radiusDeg, 1) * LATTICE_PX_PER_DEGREE;
  const level = Math.max(0, Math.round(Math.log2(worldSize(zoom) / target)));
  return Math.pow(2, -level);
}

/**
 * Build the network as one GeoJSON FeatureCollection.
 *
 * @param {RhumbOptions} options
 * @returns {Object}
 */
export function windroseNetwork(options) {
  const {
    center,
    radiusDeg,
    quarter = true,
    extend = true,
    lattice = false,
    zoom = 0,
    view = [0, 0, 1, 1],
  } = options;

  const r = radiusDeg / 360;
  if (!(r > 0)) return { type: 'FeatureCollection', features: [] };

  if (!lattice) {
    const cx = lngToMercatorX(center[0]);
    const cy = latToMercatorY(center[1]);
    const box = extend ? [0, 0, 1, 1] : [cx - r, cy - r, cx + r, cy + r];
    return {
      type: 'FeatureCollection',
      features: windroseSystem(cx, cy, r, box, { quarter }),
    };
  }

  // Cells are anchored to the world square, so panning slides the view across a
  // fixed lattice instead of dragging the roses along with it.
  const cell = latticeCell(radiusDeg, zoom);
  const bleed = extend ? cell * 0.59 : cell * 0.25;
  const range = (min, max) => {
    const first = Math.floor(min / cell);
    const last = Math.floor(max / cell);
    const middle = Math.round((first + last) / 2);
    const half = Math.floor(MAX_CELLS_PER_AXIS / 2);
    return [
      Math.max(first, middle - half),
      Math.min(last, middle + half - (MAX_CELLS_PER_AXIS % 2 ? 0 : 1)),
    ];
  };

  const [ix0, ix1] = range(view[0], view[2]);
  const [iy0, iy1] = range(view[1], view[3]);

  const features = [];
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const px = (ix + 0.5) * cell;
      const py = (iy + 0.5) * cell;
      if (py < 0 || py > 1) continue;
      const box = [px - bleed, py - bleed, px + bleed, py + bleed];
      features.push(...windroseSystem(px, py, cell / 4, box, { quarter }));
    }
  }
  return { type: 'FeatureCollection', features };
}

// --------------------------------------------------------------------------
// map layer
// --------------------------------------------------------------------------

const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * Attach the network to a map as a GeoJSON source and three line layers, one
 * per wind order so each can carry its own colour and weight.
 *
 * The layers are re-added after a basemap switch: `map.setStyle` replaces the
 * whole style, taking anything added on top of it with it.
 *
 * @param {Object} map MapLibre map
 * @param {Partial<RhumbOptions> & {enabled?: boolean, ink?: string, opacity?: number}} [options]
 * @returns {Object} handle
 */
export function createRhumb(map, options = {}) {
  const state = {
    enabled: false,
    center: [0, 0],
    radiusDeg: 14,
    quarter: true,
    extend: true,
    lattice: false,
    // A colour, or 'historical' for the black/green/red convention.
    ink: 'historical',
    opacity: 1,
    ...options,
  };

  let data = EMPTY;

  function colors() {
    if (state.ink === 'historical') return HISTORICAL_INK;
    return { quarter: state.ink, half: state.ink, principal: state.ink };
  }

  /** The visible world in normalised mercator, which is what a lattice fills. */
  function view() {
    const bounds = map.getBounds();
    const xs = [lngToMercatorX(bounds.getWest()), lngToMercatorX(bounds.getEast())];
    const ys = [latToMercatorY(bounds.getNorth()), latToMercatorY(bounds.getSouth())];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  function rebuild() {
    data = state.enabled
      ? windroseNetwork({
          ...state,
          zoom: map.getZoom(),
          view: state.lattice ? view() : undefined,
        })
      : EMPTY;
    const source = map.getSource(SOURCE_ID);
    if (source) source.setData(data);
  }

  /**
   * Put the lines under the labels, so a basemap that has any stays readable.
   */
  function beforeId() {
    const layers = map.getStyle().layers || [];
    const symbol = layers.find((layer) => layer.type === 'symbol');
    return symbol ? symbol.id : undefined;
  }

  /**
   * Idempotent, and called on every `styledata`: a style swap is asynchronous
   * and fires more than once, so the cheap thing to do is re-check rather than
   * try to catch the one event that matters.
   */
  function ensure() {
    if (!state.enabled || !map.isStyleLoaded()) return;

    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, { type: 'geojson', data });
    }
    const before = beforeId();
    const ink = colors();
    for (const order of ORDERS) {
      if (map.getLayer(LAYER_ID[order])) continue;
      map.addLayer(
        {
          id: LAYER_ID[order],
          type: 'line',
          source: SOURCE_ID,
          filter: ['==', ['get', 'wind_order'], order],
          paint: {
            'line-color': ink[order],
            'line-opacity': BASE_ALPHA[order] * state.opacity,
            'line-width': WIDTH[order],
          },
        },
        before
      );
    }
  }

  function detach() {
    for (const order of ORDERS) {
      if (map.getLayer(LAYER_ID[order])) map.removeLayer(LAYER_ID[order]);
    }
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  }

  function repaint() {
    const ink = colors();
    for (const order of ORDERS) {
      if (!map.getLayer(LAYER_ID[order])) continue;
      map.setPaintProperty(LAYER_ID[order], 'line-color', ink[order]);
      map.setPaintProperty(LAYER_ID[order], 'line-opacity', BASE_ALPHA[order] * state.opacity);
    }
  }

  map.on('styledata', ensure);
  // `styledata` can fire before the style is usable, and the last one may be
  // the one that was too early; idle is the backstop.
  map.on('idle', ensure);
  map.on('moveend', () => {
    if (state.enabled && state.lattice) rebuild();
  });

  const handle = {
    /** @param {boolean} on */
    setEnabled(on) {
      if (on === state.enabled) return handle;
      state.enabled = on;
      if (on) {
        rebuild();
        ensure();
      } else {
        detach();
        data = EMPTY;
      }
      return handle;
    },

    /**
     * @param {Partial<RhumbOptions> & {ink?: string, opacity?: number}} patch
     */
    setOptions(patch) {
      const geometryKeys = ['center', 'radiusDeg', 'quarter', 'extend', 'lattice'];
      const changesGeometry = geometryKeys.some(
        (key) => key in patch && patch[key] !== state[key]
      );
      Object.assign(state, patch);
      if (changesGeometry) rebuild();
      if ('ink' in patch || 'opacity' in patch) repaint();
      return handle;
    },

    /** Move the system to a point, usually the map centre. */
    anchorTo(lngLat) {
      return handle.setOptions({ center: [lngLat[0], lngLat[1]] });
    },

    isEnabled: () => state.enabled,

    /** For the console and for `scripts/smoke.mjs`. */
    getStats: () => ({
      enabled: state.enabled,
      lattice: state.lattice,
      features: data.features.length,
      center: state.center,
      radiusDeg: state.radiusDeg,
    }),
  };

  return handle;
}
