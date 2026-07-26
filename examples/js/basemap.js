/**
 * basemap.js
 *
 * MapLibre style definitions for the demos.
 *
 * The default basemap is deliberately self-contained: a parchment background,
 * the same land GeoJSON the waterlines are built from, and a hairline coast.
 * No tile server, no API key, nothing to expire - which is the point of a
 * reproducible example.
 *
 * The other options exist to show the overlay staying in register with
 * basemaps it knows nothing about: a hosted vector style (Woodblock) and
 * raster tiles (OSM).
 */

export const PAPER = {
  sea: '#cfdcd8',
  land: '#efe4c8',
  coast: '#9a8763',
};

/**
 * @param {string} dataUrl URL of the land GeoJSON
 * @returns {Object} a MapLibre style spec
 */
export function paperStyle(dataUrl) {
  return {
    version: 8,
    sources: {
      land: { type: 'geojson', data: dataUrl },
    },
    layers: [
      {
        id: 'sea',
        type: 'background',
        paint: { 'background-color': PAPER.sea },
      },
      {
        id: 'land',
        type: 'fill',
        source: 'land',
        paint: { 'fill-color': PAPER.land },
      },
      {
        id: 'coast',
        type: 'line',
        source: 'land',
        paint: {
          'line-color': PAPER.coast,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 12, 1.1],
          'line-opacity': 0.75,
        },
      },
    ],
  };
}

/**
 * Sea only: the waterline canvas draws the land itself (`land: 'fill'`),
 * which is the closest thing to the original Observable output.
 *
 * @returns {Object}
 */
export function seaOnlyStyle() {
  return {
    version: 8,
    sources: {},
    layers: [
      { id: 'sea', type: 'background', paint: { 'background-color': PAPER.sea } },
    ],
  };
}

/**
 * OpenHistoricalMap's Woodblock style - a hosted vector style with a woodcut
 * paper pattern, listed in https://github.com/pnorman/maplibre-styles.
 * Style and code are CC0; the data is OHM/OSM and needs attribution.
 *
 * MapLibre takes a URL in place of a style object, so there is nothing to
 * vendor and nothing to keep in sync.
 *
 * @returns {string}
 */
export function woodblockStyle() {
  return 'https://www.openhistoricalmap.org/map-styles/woodblock/woodblock.json';
}

/**
 * OpenStreetMap raster tiles, for checking that the overlay stays registered
 * with a real tiled basemap. Demo use only - respect the OSM tile usage policy
 * if you fork this.
 *
 * @returns {Object}
 */
export function osmStyle() {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 18,
        attribution: '&copy; OpenStreetMap contributors',
      },
    },
    layers: [
      { id: 'osm', type: 'raster', source: 'osm' },
      {
        id: 'wash',
        type: 'background',
        paint: { 'background-color': '#f2e7cd', 'background-opacity': 0.28 },
      },
    ],
  };
}

/**
 * @typedef {Object} Basemap
 * @property {string} label
 * @property {(dataUrl:string) => Object|string} build style spec, or a style URL
 * @property {boolean} canvasLand true when the waterline canvas should paint
 *   the land itself rather than punching a hole for the map
 * @property {string} ink suggested waterline colour
 * @property {string} [note] shown under the basemap picker
 * @property {string[]} [attribution] extra attribution lines
 */

/** @type {Record<string, Basemap>} */
export const BASEMAPS = {
  paper: {
    label: 'Paper chart',
    build: paperStyle,
    canvasLand: false,
    ink: '#6a5138',
    note: 'Self-contained: same GeoJSON as the waterlines, so coast and ripples agree exactly.',
  },
  woodblock: {
    label: 'Woodblock (OpenHistoricalMap)',
    build: woodblockStyle,
    canvasLand: false,
    ink: '#5d4632',
    note:
      'Hosted CC0 vector style. Its coastline is OSM, the waterlines are Natural Earth 10m - ' +
      'they diverge above about zoom 9.',
    attribution: [
      '<a href="https://www.openhistoricalmap.org/" target="_blank" rel="noopener">OpenHistoricalMap</a>',
      'Woodblock style CC0',
    ],
  },
  canvas: {
    label: 'Canvas-drawn land',
    build: seaOnlyStyle,
    canvasLand: true,
    ink: '#2f6f7e',
    note: 'The map draws only the sea; the waterline canvas fills the land, as the notebook did.',
  },
  osm: {
    label: 'OpenStreetMap',
    build: osmStyle,
    canvasLand: false,
    ink: '#2b5f8a',
    note: 'Raster tiles, to show the overlay tracking something it knows nothing about.',
    attribution: [
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    ],
  },
};

/**
 * Swap the map's basemap and keep attribution honest.
 *
 * MapLibre's attribution control takes its custom lines at construction, so
 * changing basemap means replacing the control.
 *
 * @param {Object} map MapLibre map
 * @param {string} key key in {@link BASEMAPS}
 * @param {string} dataUrl land GeoJSON URL, for the styles that use it
 * @param {{control?: Object}} [state] holds the current attribution control
 * @returns {Basemap}
 */
export function applyBasemap(map, key, dataUrl, state = {}) {
  const basemap = BASEMAPS[key];
  if (!basemap) throw new Error(`Unknown basemap "${key}"`);

  map.setStyle(basemap.build(dataUrl));

  if (state.control) map.removeControl(state.control);
  state.control = new maplibregl.AttributionControl({
    compact: true,
    customAttribution: basemap.attribution || [],
  });
  map.addControl(state.control, 'bottom-right');

  return basemap;
}
