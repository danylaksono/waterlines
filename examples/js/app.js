/**
 * app.js
 *
 * Demo wiring: a MapLibre map of the Indonesian archipelago with waterlines
 * drawn on a 2D canvas above it.
 *
 * Everything here is glue. The technique is in `src/render/WaterlineRenderer.js`,
 * and what makes it survive being run every frame is in
 * `src/render/WaterlineEngine.js`. The panel itself lives in
 * `shared/js/waterline-controls.js`, shared with `studio/index.html`.
 */

import { WaterlinesOverlay } from '../../src/adapters/maplibre.js';
import { resolveStyle } from '../../src/render/style.js';
import { BASEMAPS, applyBasemap } from '../../shared/js/basemap.js';
import { REGIONS, flyToRegion } from './regions.js';
import { buildPanel, section } from '../../shared/js/controls.js';
import { createHud } from './hud.js';
import { applyGrain } from '../../shared/js/paper.js';
import {
  animationFields,
  applyAnimationChange,
  applyPresetToPanel,
  applyQualityChange,
  qualityFields,
  styleFromValues,
  waterlineFields,
} from '../../shared/js/waterline-controls.js';

const DATA_URL = new URL('../../data/indonesia-land.geojson', import.meta.url).href;

const state = {
  map: null,
  overlay: null,
  land: null,
  basemap: 'paper',
  panel: null,
  motionPanel: null,
  hud: null,
  applying: false,
  attribution: {},
};

boot().catch((error) => {
  document.getElementById('loading').textContent = `Failed to start: ${error.message}`;
  throw error;
});

async function boot() {
  applyGrain(document.getElementById('grain'));

  const response = await fetch(DATA_URL);
  if (!response.ok) {
    throw new Error(`could not load ${DATA_URL} (run "npm run data" to generate it)`);
  }
  state.land = await response.json();

  state.map = new maplibregl.Map({
    container: 'map',
    style: BASEMAPS.paper.build(DATA_URL),
    center: REGIONS.archipelago.center,
    zoom: REGIONS.archipelago.zoom,
    minZoom: 4.2,
    maxZoom: 14,
    // A 2D canvas cannot do perspective, and the overlay's transform is
    // affine, so the demo stays flat. Bearing is fine - the affine picks up
    // rotation for free.
    pitch: 0,
    maxPitch: 0,
    pitchWithRotate: false,
    attributionControl: false,
  });

  state.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  state.map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');
  state.attribution.control = new maplibregl.AttributionControl({ compact: true });
  state.map.addControl(state.attribution.control, 'bottom-right');

  await once(state.map, 'load');

  const hud = createHud(document.getElementById('hud-body'));
  state.hud = hud;

  state.overlay = new WaterlinesOverlay(state.map, {
    data: state.land,
    // Pinned to the canvas renderer on purpose. The distance-field renderer is
    // the faster one and is what `renderer: 'auto'` picks, but this page is
    // also the reference for the 2D path's scheduling behaviour - the draft
    // ladder, the raster cache, the frame budget in the HUD - none of which
    // exist on the GL path because none of them need to. Switch it in the
    // Performance panel, or see examples/renderer-comparison.html for both.
    renderer: '2d',
    style: { preset: 'antique' },
    onFrame: (stats) => hud.update(stats),
  });

  buildUi();
  document.getElementById('loading').remove();

  // Handle for the console and for scripts/smoke.mjs.
  window.__waterlines = state;

  const loop = () => {
    hud.tick();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// --------------------------------------------------------------------------
// UI
// --------------------------------------------------------------------------

function buildUi() {
  const root = document.getElementById('panel-body');
  const initial = resolveStyle({ preset: 'antique' });

  const places = section(root, 'Where', true);
  buildPanel(
    places,
    [
      {
        name: 'region',
        label: 'Jump to',
        type: 'buttons',
        value: 'archipelago',
        options: Object.entries(REGIONS).map(([value, r]) => ({
          value,
          label: r.label,
          title: r.note,
        })),
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
      if (name === 'region') {
        const region = flyToRegion(state.map, value);
        document.getElementById('region-note').textContent = region.note;
      } else if (name === 'basemap') {
        setBasemap(value);
      }
    }
  );
  document.getElementById('region-note').textContent = REGIONS.archipelago.note;
  setBasemapNote('paper');

  const look = section(root, 'Waterlines', true);
  state.panel = buildPanel(
    look,
    waterlineFields(initial, BASEMAPS.paper.ink),
    onStyleChange
  );

  const motion = section(root, 'Motion', false);
  state.motionPanel = buildPanel(motion, animationFields(), (name, value, values) =>
    applyAnimationChange(state.overlay, name, value, values)
  );

  const quality = section(root, 'Performance', false);
  buildPanel(quality, qualityFields({ renderer: true, value: state.overlay.renderer }), (name, value, values) => {
    if (name === 'renderer') return swapRenderer(value, values);
    applyQualityChange(state.overlay, name, value, values);
  });
}

/**
 * Rebuild the overlay on the other renderer.
 *
 * A renderer owns a canvas and, on the GL path, a set of GPU resources, so
 * switching means tearing one down and building the other rather than flipping
 * a flag. Everything else - the map, the data, the panel - survives, which is
 * the point of the two engines sharing a surface. The *overlay* does not, so
 * anything living on it has to be re-applied: the animation, in particular,
 * since the panel still shows it switched on.
 */
function swapRenderer(renderer, values) {
  const hud = state.hud;
  state.overlay.remove();
  state.overlay = new WaterlinesOverlay(state.map, {
    data: state.land,
    renderer,
    style: currentStyle(),
    onFrame: (stats) => hud.update(stats),
    lod: {
      curve: values.curve,
      tolerancePx: values.tolerancePx,
      minRingPx: values.minRingPx,
    },
  });
  if (state.motionPanel) {
    applyAnimationChange(state.overlay, 'animate', null, state.motionPanel.values);
  }
  if (state.overlay.renderer !== renderer) {
    document.getElementById('basemap-note').textContent =
      'WebGL2 with float render targets is unavailable here, so the canvas renderer is still in use.';
  }
}

function onStyleChange(name, value, values) {
  if (state.applying) return;

  if (name === 'preset') {
    const resolved = applyPresetToPanel(
      state.panel,
      value,
      () => { state.applying = true; },
      () => { state.applying = false; }
    );
    // Presets may carry things the sliders do not expose - a colour *function*,
    // for one - so apply the preset itself, then the slider overrides.
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
  const basemap = applyBasemap(state.map, key, DATA_URL, state.attribution);
  setBasemapNote(key);

  // Propose an ink that suits the new paper. It lands in the visible swatch,
  // so it is a suggestion the user can immediately see and override.
  state.applying = true;
  state.panel.set('color', basemap.ink);
  state.applying = false;

  state.map.once('styledata', () => state.overlay.setStyle(currentStyle()));
}

function setBasemapNote(key) {
  document.getElementById('basemap-note').textContent = BASEMAPS[key].note || '';
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}
