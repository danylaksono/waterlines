/**
 * comparison.js
 *
 * Two maps, one view, one style, two renderers - so the distance-field path
 * can be judged against the canvas one rather than described.
 *
 * The maps are kept in lockstep by copying the camera from whichever the user
 * is touching. That is the only way to make the comparison honest: the same
 * pixels of coastline, at the same zoom, at the same instant.
 */

import { WaterlinesOverlay } from '../../src/adapters/maplibre.js';
import { affineFromMap } from '../../src/adapters/transform.js';
import { seaOnlyStyle } from '../../shared/js/basemap.js';

const DATA_URL = new URL('../../data/indonesia-land.geojson', import.meta.url).href;
const HOME = { center: [117.8, -2.2], zoom: 4.2 };

const BASE_STYLE = {
  preset: 'antique',
  count: 14,
  extent: 46,
};

const panes = {};
let syncing = false;

boot().catch((err) => {
  for (const id of ['tag-2d', 'tag-gl']) {
    document.querySelector(`#${id} span`).textContent = `failed: ${err.message}`;
  }
  throw err;
});

async function boot() {
  const response = await fetch(DATA_URL);
  if (!response.ok) {
    throw new Error(`could not load ${DATA_URL} (run "npm run data")`);
  }
  const land = await response.json();

  panes['2d'] = await makePane('map-2d', 'tag-2d', land, '2d');
  panes.gl = await makePane('map-gl', 'tag-gl', land, 'gl');

  for (const [key, pane] of Object.entries(panes)) {
    pane.map.on('move', () => sync(key));
  }

  wireControls();
  // Handles for scripts/smoke.mjs, the benchmark and the console.
  window.__comparison = panes;
  window.__benchMatrix = affineFromMap;
}

async function makePane(mapId, tagId, land, renderer) {
  const map = new maplibregl.Map({
    container: mapId,
    style: seaOnlyStyle(),
    center: HOME.center,
    zoom: HOME.zoom,
    pitch: 0,
    maxPitch: 0,
    pitchWithRotate: false,
    attributionControl: false,
  });
  await new Promise((resolve) => map.on('load', resolve));

  const tag = document.querySelector(`#${tagId} span`);
  let overlay;
  try {
    overlay = new WaterlinesOverlay(map, {
      data: land,
      renderer,
      style: BASE_STYLE,
    });
  } catch (err) {
    tag.innerHTML = `<span class="miss">unavailable: ${err.message}</span>`;
    return { map, overlay: null, tag, renderer };
  }

  if (overlay.renderer !== renderer) {
    tag.innerHTML = `<span class="miss">${renderer} unavailable, fell back to ${overlay.renderer}</span>`;
  }

  const pane = { map, overlay, tag, renderer, frames: 0, ms: 0 };
  let last = 0;
  const tick = (t) => {
    if (last) {
      pane.frames++;
      pane.ms += t - last;
      if (pane.frames >= 30) {
        report(pane);
        pane.frames = 0;
        pane.ms = 0;
      }
    }
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return pane;
}

function report(pane) {
  const stats = pane.overlay ? pane.overlay.getStats() : null;
  if (!stats) return;
  const interval = (pane.ms / pane.frames).toFixed(1);
  const lines = [`${interval} ms/frame`];

  if (stats.renderer === 'gl') {
    lines.push(`${stats.floodPasses} flood passes`);
    lines.push(`${stats.vertices.toLocaleString()} vertices, exact at every zoom`);
    lines.push(stats.animating ? 'animating live' : 'still');
  } else {
    lines.push(`mode: ${stats.mode}${stats.draft ? ' (draft)' : ''}`);
    lines.push(`${stats.vertices.toLocaleString()} vertices, ${stats.rings} rings`);
    lines.push(
      stats.animating
        ? `animating: ${stats.cycleFrames || 0} cached frames`
        : 'still'
    );
  }
  pane.tag.innerHTML = lines.join('<br>');
}

/** Copy the camera from the pane the user is driving to the other one. */
function sync(from) {
  if (syncing) return;
  syncing = true;
  const source = panes[from].map;
  for (const [key, pane] of Object.entries(panes)) {
    if (key === from) continue;
    pane.map.jumpTo({
      center: source.getCenter(),
      zoom: source.getZoom(),
      bearing: source.getBearing(),
    });
  }
  syncing = false;
}

function wireControls() {
  const count = document.getElementById('count');
  const extent = document.getElementById('extent');
  const animate = document.getElementById('animate');

  const apply = () => {
    document.getElementById('count-out').textContent = count.value;
    document.getElementById('extent-out').textContent = `${extent.value} px`;
    for (const pane of Object.values(panes)) {
      if (!pane.overlay) continue;
      pane.overlay.setStyle({
        ...BASE_STYLE,
        count: Number(count.value),
        extent: Number(extent.value),
      });
    }
  };
  count.addEventListener('input', apply);
  extent.addEventListener('input', apply);

  animate.addEventListener('change', () => {
    for (const pane of Object.values(panes)) {
      if (!pane.overlay) continue;
      pane.overlay.setAnimation(
        animate.checked ? { periodMs: 1600, direction: 'outwards', frames: 12 } : null
      );
    }
  });

  document.getElementById('fit').addEventListener('click', () => {
    panes['2d'].map.jumpTo(HOME);
    sync('2d');
  });
}
