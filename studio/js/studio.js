/**
 * studio.js
 *
 * Drives `studio/index.html`, served at `/studio`. Same map, same panel, same
 * waterlines as `examples/indonesia-maplibre.html` - plus the two things you
 * need to use this on your own data: load a GeoJSON, and save the result as
 * a PNG.
 *
 * The waterline and performance sections come from
 * `shared/js/waterline-controls.js`, shared with the other page, so the two
 * never drift apart.
 */

import { WaterlinesOverlay } from '../../src/adapters/maplibre.js';
import { resolveStyle } from '../../src/render/style.js';
import { BASEMAPS, applyBasemap } from '../../shared/js/basemap.js';
import { buildPanel, section } from '../../shared/js/controls.js';
import { PLACEMENTS, createCompass } from './compass.js';
import { applyGrain } from '../../shared/js/paper.js';
import { attachDropZone, fetchGeoJson, parseGeoJson, readGeoJsonFile } from './geojson-input.js';
import { exportPng } from './export-png.js';
import { createRhumb } from './rhumb.js';
import {
  applyPresetToPanel,
  applyQualityChange,
  qualityFields,
  styleFromValues,
  waterlineFields,
} from '../../shared/js/waterline-controls.js';

// Resolved against this module, not the page: the studio is served from
// `/studio/`, the other examples from `/examples/`.
const sample = (file) => new URL(`../../data/${file}`, import.meta.url).href;

const SAMPLES = {
  indonesia: { label: 'Indonesia', url: sample('indonesia-land.geojson') },
  bali: { label: 'Bali & Lombok', url: sample('bali-land.geojson') },
  'raja-ampat': { label: 'Raja Ampat', url: sample('raja-ampat-land.geojson') },
};

const ROSE = { radius: 62, inset: 18, placement: 'bottom-right' };
const RHUMB = { radiusDeg: 14, opacity: 1 };

const state = {
  map: null,
  overlay: null,
  compass: null,
  rhumb: null,
  data: null,
  basemap: 'paper',
  panel: null,
  rhumbPanel: null,
  rhumbAnchored: false,
  exportValues: { scale: '1', grain: true, vignette: true, compass: true },
  applying: false,
  attribution: {},
};

boot().catch((error) => {
  document.getElementById('loading').textContent = `Failed to start: ${error.message}`;
  throw error;
});

async function boot() {
  applyGrain(document.getElementById('grain'));

  const initial = await fetchGeoJson(new URL(SAMPLES.indonesia.url, import.meta.url).href);

  state.map = new maplibregl.Map({
    container: 'map',
    style: BASEMAPS.paper.build(sourceUrlFor(initial)),
    center: [117.8, -2.2],
    zoom: 4.2,
    pitch: 0,
    maxPitch: 0,
    pitchWithRotate: false,
    attributionControl: false,
    // Required to read the map's pixels back for the PNG export. It costs a
    // little performance, which is the right trade on a page whose job is
    // producing images.
    preserveDrawingBuffer: true,
  });

  state.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  state.map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');
  state.attribution.control = new maplibregl.AttributionControl({ compact: true });
  state.map.addControl(state.attribution.control, 'bottom-right');

  await new Promise((resolve) => state.map.once('load', resolve));

  state.overlay = new WaterlinesOverlay(state.map, {
    data: initial.geojson,
    style: { preset: 'antique' },
  });

  state.compass = createCompass(state.map, document.getElementById('compass'), {
    radius: ROSE.radius,
    inset: ROSE.inset,
    placement: ROSE.placement,
    ink: BASEMAPS.paper.ink,
  });

  // Off until asked for: it is a strong graphic device, and the page's default
  // picture is the waterlines.
  state.rhumb = createRhumb(state.map, { radiusDeg: RHUMB.radiusDeg, opacity: RHUMB.opacity });

  buildUi();
  useData(initial, { fit: false });

  // Drop a file anywhere on the page.
  attachDropZone(
    document.body,
    (file) => loadFile(file),
    (active) => document.getElementById('app').classList.toggle('is-dropping', active)
  );

  document.getElementById('loading').remove();
  // Handle for the console and for scripts/smoke.mjs.
  state.paintCompass = paintCompass;
  window.__waterlinesStudio = state;
}

// --------------------------------------------------------------------------
// data
// --------------------------------------------------------------------------

/**
 * Adopt a loaded dataset: hand it to the overlay, point the basemap's land
 * layer at it, and frame it.
 *
 * @param {import('./geojson-input.js').LoadedData} data
 * @param {{fit?: boolean}} [options]
 */
function useData(data, options = {}) {
  state.data = data;
  state.overlay.setData(data.geojson);

  const source = state.map.getSource('land');
  if (source) source.setData(data.geojson);

  if (options.fit !== false) {
    state.map.fitBounds(data.bounds, { padding: 80, duration: 900, maxZoom: 12 });
  }

  setStatus(
    `${data.name} — ${data.rings.toLocaleString()} rings, ` +
      `${data.vertices.toLocaleString()} vertices`
  );
}

async function loadFile(file) {
  setStatus(`reading ${file.name}…`);
  try {
    useData(await readGeoJsonFile(file));
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loadUrl(url) {
  setStatus(`fetching ${url}…`);
  try {
    useData(await fetchGeoJson(url));
  } catch (error) {
    setStatus(error.message, true);
  }
}

/**
 * The paper basemap wants a URL for its `land` source at construction time.
 * Once a user's own data is in play it is set with `setData` instead, so the
 * initial URL only has to be something valid.
 */
function sourceUrlFor() {
  return new URL(SAMPLES.indonesia.url, import.meta.url).href;
}

// --------------------------------------------------------------------------
// UI
// --------------------------------------------------------------------------

function buildUi() {
  const root = document.getElementById('panel-body');
  const initial = resolveStyle({ preset: 'antique' });

  wirePanelToggle();

  buildDataSection(section(root, 'Data', true));

  const look = section(root, 'Waterlines', true);
  state.panel = buildPanel(look, waterlineFields(initial, BASEMAPS.paper.ink), onStyleChange);

  buildRoseSection(section(root, 'Wind rose', false));
  buildRhumbSection(section(root, 'Rhumb lines', false));
  buildExportSection(section(root, 'Export', true));

  const quality = section(root, 'Performance', false);
  buildPanel(quality, qualityFields(), (name, value, values) =>
    applyQualityChange(state.overlay, name, value, values)
  );
}

function buildDataSection(body) {
  buildPanel(
    body,
    [
      {
        name: 'sample',
        label: 'Sample data',
        type: 'buttons',
        value: 'indonesia',
        options: Object.entries(SAMPLES).map(([value, s]) => ({ value, label: s.label })),
      },
      {
        name: 'basemap',
        label: 'Basemap',
        type: 'select',
        value: 'paper',
        options: Object.entries(BASEMAPS).map(([value, b]) => ({ value, label: b.label })),
      },
    ],
    (name, value) => {
      if (name === 'sample') {
        loadUrl(new URL(SAMPLES[value].url, import.meta.url).href);
      } else if (name === 'basemap') {
        setBasemap(value);
      }
    }
  );
  setBasemapNote('paper');

  // File input and URL box are hand-built: they are actions, not settings, so
  // they do not belong in the declarative panel.
  const drop = document.createElement('div');
  drop.className = 'dropzone';
  drop.innerHTML =
    '<strong>Drop a GeoJSON anywhere</strong>' +
    '<span>Polygons or multipolygons — land, lakes, buildings, anything with an edge.</span>';

  const pick = document.createElement('input');
  pick.type = 'file';
  pick.accept = '.geojson,.json,application/geo+json,application/json';
  pick.className = 'file';
  pick.addEventListener('change', () => {
    if (pick.files && pick.files[0]) loadFile(pick.files[0]);
    pick.value = '';
  });
  drop.appendChild(pick);
  body.appendChild(drop);

  const urlRow = document.createElement('div');
  urlRow.className = 'field';
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = '…or paste a GeoJSON URL';
  urlInput.className = 'text';
  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && urlInput.value.trim()) loadUrl(urlInput.value.trim());
  });
  urlRow.appendChild(urlInput);
  body.appendChild(urlRow);

  const status = document.createElement('p');
  status.className = 'hint';
  status.id = 'data-status';
  body.appendChild(status);
}

function buildRoseSection(body) {
  buildPanel(
    body,
    [
      {
        name: 'placement',
        label: 'Placement',
        type: 'buttons',
        value: ROSE.placement,
        options: [
          ...Object.entries(PLACEMENTS).map(([value, p]) => ({ value, label: p.label })),
          { value: 'off', label: 'Off', title: 'Hide the rose, on screen and in exports' },
        ],
        hint:
          'The corner is used for the exported image too. On screen the panel and ' +
          'the map controls sit on top of it, so a left-hand corner may be partly ' +
          'hidden here but will be clear in the export.',
      },
      {
        name: 'radius',
        label: 'Size',
        type: 'range',
        min: 34,
        max: 120,
        step: 2,
        value: ROSE.radius,
        format: (v) => `${v * 2} px`,
      },
      {
        name: 'inset',
        label: 'Offset from edge',
        type: 'range',
        min: 0,
        max: 200,
        step: 2,
        value: ROSE.inset,
        format: (v) => `${v} px`,
        hint:
          'Measured from both edges of the chosen corner at once, and from the ' +
          'rose’s bounding box rather than its ring — so the letters stay ' +
          'inside the image at 0.',
      },
    ],
    (name, value) => {
      if (name === 'placement') state.compass.setPlacement(value);
      else if (name === 'radius') state.compass.setRadius(value);
      else if (name === 'inset') state.compass.setInset(value);
    }
  );
}

/**
 * The portolan wind-rose network. Unlike the waterlines and the rose in the
 * corner this is not canvas work at all - it is a GeoJSON source and three line
 * layers, so it costs nothing per frame and reaches the export through the map
 * canvas like any other basemap layer.
 */
function buildRhumbSection(body) {
  const panel = buildPanel(
    body,
    [
      {
        name: 'enabled',
        label: 'Draw rhumb lines',
        type: 'checkbox',
        value: false,
      },
      {
        name: 'mode',
        label: 'System',
        type: 'buttons',
        value: 'single',
        options: [
          { value: 'single', label: 'One rose', title: 'A single chart, as a portolan was drawn' },
          {
            value: 'lattice',
            label: 'Lattice',
            title: 'Repeat the rose on a world-aligned grid, so density holds at any zoom',
          },
        ],
        hint:
          'One system is historically right but thins out as you zoom in. The ' +
          'lattice puts a rose in every quadtree cell instead, so the weave ' +
          'holds its size at any scale — which no real chart did.',
      },
      {
        name: 'radius',
        label: 'Circle radius',
        type: 'range',
        min: 2,
        max: 60,
        step: 1,
        value: RHUMB.radiusDeg,
        format: (v) => `${v}°`,
        hint:
          'Degrees of longitude for one system. On the lattice there is no one ' +
          'circle to measure, so it reads as apparent size and snaps to the ' +
          'nearest quadtree level.',
      },
      { name: 'quarter', label: 'Quarter winds', type: 'checkbox', value: true },
      { name: 'extend', label: 'Extend past the circle', type: 'checkbox', value: true },
      {
        name: 'ink',
        label: 'Colour',
        type: 'select',
        value: 'historical',
        options: [
          { value: 'historical', label: 'Chart convention — black, green, red' },
          { value: 'basemap', label: 'One ink, from the basemap' },
        ],
      },
      {
        name: 'opacity',
        label: 'Weight',
        type: 'range',
        min: 0.2,
        max: 1,
        step: 0.05,
        value: RHUMB.opacity,
        format: (v) => `${Math.round(v * 100)}%`,
      },
    ],
    (name, value) => {
      if (name === 'enabled') {
        // Anchor on the first switch-on, so the web arrives around whatever the
        // user is looking at rather than at 0°N 0°E.
        if (value && !state.rhumbAnchored) anchorRhumb();
        state.rhumb.setEnabled(value);
      } else if (name === 'mode') {
        state.rhumb.setOptions({ lattice: value === 'lattice' });
      } else if (name === 'radius') {
        state.rhumb.setOptions({ radiusDeg: value });
      } else if (name === 'quarter' || name === 'extend') {
        state.rhumb.setOptions({ [name]: value });
      } else if (name === 'ink') {
        state.rhumb.setOptions({ ink: rhumbInk(value) });
      } else if (name === 'opacity') {
        state.rhumb.setOptions({ opacity: value });
      }
      setRhumbStatus();
    }
  );
  state.rhumbPanel = panel;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary';
  button.id = 'rhumb-anchor';
  button.textContent = 'Anchor the rose at the map centre';
  button.addEventListener('click', () => {
    anchorRhumb();
    setRhumbStatus();
  });
  body.appendChild(button);

  const status = document.createElement('p');
  status.className = 'hint';
  status.id = 'rhumb-status';
  body.appendChild(status);

  // A lattice is rebuilt around the new view when the map settles, so the line
  // count it reports moves with the map.
  state.map.on('moveend', setRhumbStatus);
}

function anchorRhumb() {
  const { lng, lat } = state.map.getCenter();
  state.rhumb.anchorTo([lng, lat]);
  state.rhumbAnchored = true;
}

/** @param {string} choice `historical`, or `basemap` for the basemap's ink */
function rhumbInk(choice) {
  return choice === 'basemap' ? BASEMAPS[state.basemap].ink : 'historical';
}

function setRhumbStatus() {
  const status = document.getElementById('rhumb-status');
  if (!status) return;
  const stats = state.rhumb.getStats();
  if (!stats.enabled) {
    status.textContent = '';
    return;
  }
  const [lng, lat] = stats.center;
  status.textContent =
    `${stats.features.toLocaleString()} lines, centred on ` +
    `${lat.toFixed(2)}°, ${lng.toFixed(2)}°`;
}

/**
 * Fold the panel away, so the map can be framed and screenshotted without the
 * controls in the picture. The panel collapses to the button itself rather than
 * hiding it too, or there would be no way back.
 */
function wirePanelToggle() {
  const panel = document.getElementById('panel');
  const button = document.getElementById('panel-toggle');

  const set = (open) => {
    panel.classList.toggle('is-collapsed', !open);
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Hide' : 'Controls';
    button.title = open ? 'Hide the panel (H)' : 'Show the panel (H)';
  };

  button.addEventListener('click', () => set(panel.classList.contains('is-collapsed')));

  // A shortcut is worth having on a page used for framing shots, but it must
  // not fire while the URL box or a slider has focus.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'h' && event.key !== 'H') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = event.target instanceof HTMLElement ? event.target.tagName : '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    set(panel.classList.contains('is-collapsed'));
  });
}

function buildExportSection(body) {
  const panel = buildPanel(
    body,
    [
      {
        name: 'scale',
        label: 'Resolution',
        type: 'select',
        value: '1',
        options: [
          { value: '1', label: 'Screen (1x)' },
          { value: '2', label: '2x — re-renders the map' },
          { value: '3', label: '3x — re-renders the map' },
        ],
        hint: 'Above 1x the map is temporarily resized, so the view flickers while it renders.',
      },
      { name: 'grain', label: 'Include paper grain', type: 'checkbox', value: true },
      { name: 'vignette', label: 'Include vignette', type: 'checkbox', value: true },
      { name: 'compass', label: 'Include wind rose', type: 'checkbox', value: true },
    ],
    (name, value) => {
      state.exportValues[name] = value;
    }
  );
  state.exportValues = panel.values;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary';
  button.id = 'export-button';
  button.textContent = 'Save PNG';
  button.addEventListener('click', () => savePng(button));
  body.appendChild(button);

  const status = document.createElement('p');
  status.className = 'hint';
  status.id = 'export-status';
  body.appendChild(status);
}

async function savePng(button) {
  const status = document.getElementById('export-status');
  button.disabled = true;
  try {
    const result = await exportPng({
      map: state.map,
      overlay: state.overlay,
      scale: Number(state.exportValues.scale),
      grain: state.exportValues.grain,
      vignette: state.exportValues.vignette,
      decorate: state.exportValues.compass ? paintCompass : undefined,
      onProgress: (message) => {
        status.textContent = message;
      },
    });
    status.textContent = `saved ${result.filename} (${result.width}x${result.height})`;
  } catch (error) {
    status.textContent = `export failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

/**
 * Paint the wind rose into the export canvas. Placement and size come from the
 * compass itself, so the image matches the screen.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width  export width in device px
 * @param {number} height export height in device px
 * @param {number} k device px per on-screen CSS px
 */
function paintCompass(ctx, width, height, k) {
  state.compass.paintInto(ctx, width, height, k);
}

function onStyleChange(name, value) {
  if (state.applying) return;

  if (name === 'preset') {
    const resolved = applyPresetToPanel(
      state.panel,
      value,
      () => { state.applying = true; },
      () => { state.applying = false; }
    );
    state.overlay.setStyle({ preset: value, ...currentStyle(resolved) });
    return;
  }
  state.overlay.setStyle(currentStyle());
}

function currentStyle(preset) {
  return styleFromValues(state.panel.values, {
    canvasLand: BASEMAPS[state.basemap].canvasLand,
    preset,
  });
}

function setBasemap(key) {
  state.basemap = key;
  const basemap = applyBasemap(state.map, key, sourceUrlFor(), state.attribution);
  setBasemapNote(key);

  state.applying = true;
  state.panel.set('color', basemap.ink);
  state.applying = false;
  state.compass.setColors(basemap.ink);
  if (state.rhumbPanel) state.rhumb.setOptions({ ink: rhumbInk(state.rhumbPanel.values.ink) });

  state.map.once('styledata', () => {
    // The new style brings a fresh `land` source; point it at the loaded data.
    const source = state.map.getSource('land');
    if (source && state.data) source.setData(state.data.geojson);
    state.overlay.setStyle(currentStyle());
  });
}

function setBasemapNote(key) {
  document.getElementById('basemap-note').textContent = BASEMAPS[key].note || '';
}

function setStatus(message, isError = false) {
  const status = document.getElementById('data-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}
