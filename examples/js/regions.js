/**
 * regions.js
 *
 * Camera presets for the Indonesian archipelago, chosen to exercise different
 * parts of the technique: one big island, a strait, a shattered reef complex,
 * and the whole country at once.
 */

/**
 * @typedef {Object} Region
 * @property {string} label
 * @property {[number, number]} center
 * @property {number} zoom
 * @property {string} note what this view is good for
 */

/** @type {Record<string, Region>} */
export const REGIONS = {
  archipelago: {
    label: 'Nusantara',
    center: [117.8, -2.2],
    zoom: 4.2,
    note: 'The whole archipelago - ~1,100 rings, heavy cull and LOD work',
  },
  bali: {
    label: 'Bali & Lombok',
    center: [115.75, -8.5],
    zoom: 8.3,
    note: 'Two islands and a deep strait; ripples meet in the Lombok Strait',
  },
  komodo: {
    label: 'Komodo & Flores',
    center: [119.75, -8.5],
    zoom: 8.8,
    note: 'Dense small islands - the near-Voronoi effect shows up here',
  },
  rajaAmpat: {
    label: 'Raja Ampat',
    center: [130.6, -0.9],
    zoom: 8.6,
    note: 'Hundreds of karst islets; the LOD ring-culling earns its keep',
  },
  banda: {
    label: 'Banda Islands',
    center: [129.89, -4.53],
    zoom: 10.5,
    note: 'A single volcanic cluster at high zoom',
  },
  seribu: {
    label: 'Kepulauan Seribu',
    center: [106.56, -5.72],
    zoom: 9.6,
    note: 'Tiny coral cays north of Jakarta - sub-pixel ring culling in action',
  },
  sulawesi: {
    label: 'Sulawesi',
    center: [121.0, -2.4],
    zoom: 6.0,
    note: 'One deeply lobed coastline - a stress test for curve smoothing',
  },
};

/**
 * @param {Object} map MapLibre map
 * @param {string} key key in {@link REGIONS}
 * @param {Object} [options] passed to `map.flyTo`
 */
export function flyToRegion(map, key, options = {}) {
  const region = REGIONS[key];
  if (!region) throw new Error(`Unknown region "${key}"`);
  map.flyTo({
    center: region.center,
    zoom: region.zoom,
    speed: 1.1,
    curve: 1.4,
    ...options,
  });
  return region;
}
