/**
 * style.mjs
 *
 * Builds a native MapLibre GL style from the ring GeoJSON `build-rings.mjs`
 * wrote. No canvas, no per-frame drawing: every ripple is a real `line`
 * feature, and the fade is baked into its `color`/`alpha`/`width`
 * properties, so the paint layer is just `['get', ...]` lookups.
 *
 * Plain browser ESM, no build step - loaded straight from `index.html`.
 */

export const PAPER = {
  sea: '#cfdcd8',
  land: '#efe4c8',
  coast: '#9a8763',
};

/**
 * @param {Object} options
 * @param {string} options.landUrl land GeoJSON (the same source the rings were buffered from)
 * @param {string} options.ringsUrl ring GeoJSON from `build-rings.mjs`
 * @param {string} [options.sea]
 * @param {string} [options.land]
 * @param {string} [options.coast]
 * @returns {Object} a MapLibre style spec
 */
export function ringStyle({ landUrl, ringsUrl, sea = PAPER.sea, land = PAPER.land, coast = PAPER.coast }) {
  return {
    version: 8,
    sources: {
      land: { type: 'geojson', data: landUrl },
      rings: { type: 'geojson', data: ringsUrl },
    },
    layers: [
      { id: 'sea', type: 'background', paint: { 'background-color': sea } },
      { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': land } },
      {
        id: 'waterline-rings',
        type: 'line',
        source: 'rings',
        layout: { 'line-cap': 'round', 'line-join': 'bevel' },
        paint: {
          // Precomputed per-feature by build-rings.mjs - no expressions needed
          // beyond a lookup. `line-width` is screen px regardless of zoom,
          // same as the canvas renderer's stroke width; only the ring
          // *positions* are real offset geometry and so scale with the map.
          'line-color': ['get', 'color'],
          'line-opacity': ['get', 'alpha'],
          'line-width': ['get', 'width'],
        },
      },
      {
        id: 'coast',
        type: 'line',
        source: 'land',
        paint: {
          'line-color': coast,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 12, 1.1],
          'line-opacity': 0.75,
        },
      },
    ],
  };
}
