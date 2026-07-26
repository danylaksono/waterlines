/**
 * app.js
 *
 * Minimal viewer for the ring-baked MapLibre style. Swaps between the
 * pre-generated region/preset combos with `map.setStyle`, same pattern as
 * `examples/js/basemap.js`.
 */

import { ringStyle } from './style.mjs';

// Must match REFERENCE_ZOOM in build-rings.mjs: that is the one zoom at which
// each ring's baked (real, metric) offset agrees with the canvas renderer's
// screen-pixel offset. Away from it the rings will look tighter (zoomed in)
// or looser (zoomed out) than the canvas version would draw - that drift is
// the whole point of this prototype, so it's left visible rather than hidden.
const REFERENCE_ZOOM = 9;

const DATASETS = [
  {
    region: 'bali',
    preset: 'classic',
    label: 'Bali - classic',
    center: [115.19, -8.45],
  },
  {
    region: 'raja-ampat',
    preset: 'nautical',
    label: 'Raja Ampat - nautical',
    center: [130.5, -0.4],
  },
];

const select = document.getElementById('dataset');
const note = document.getElementById('note');
for (const d of DATASETS) {
  const opt = document.createElement('option');
  opt.value = `${d.region}:${d.preset}`;
  opt.textContent = d.label;
  select.appendChild(opt);
}

const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(DATASETS[0]),
  center: DATASETS[0].center,
  zoom: REFERENCE_ZOOM,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
updateNote(DATASETS[0]);

select.addEventListener('change', () => {
  const [region, preset] = select.value.split(':');
  const dataset = DATASETS.find((d) => d.region === region && d.preset === preset);
  map.setStyle(buildStyle(dataset));
  map.jumpTo({ center: dataset.center, zoom: REFERENCE_ZOOM });
  updateNote(dataset);
});

function buildStyle({ region, preset }) {
  return ringStyle({
    landUrl: `/data/${region}-land.geojson`,
    ringsUrl: `/maplibre-style/data/${region}-${preset}-rings.geojson`,
  });
}

function updateNote(dataset) {
  note.textContent =
    `Baked at zoom ${REFERENCE_ZOOM}. Zoom in and the rings spread further ` +
    `apart than the canvas version would draw them; zoom out and they crowd ` +
    `closer - real offset distances, not screen-pixel ones.`;
}
