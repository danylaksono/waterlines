/**
 * deck-app.js
 *
 * The same waterlines overlay, driven by a deck.gl viewport instead of a
 * MapLibre map transform.
 *
 * The overlay stays on its own 2D canvas rather than becoming a deck layer,
 * and that is deliberate: the technique is built on `destination-out`
 * compositing (see `src/render/WaterlineRenderer.js`), which has no equivalent
 * in a deck.gl layer. What the adapter needs from deck is only the viewport,
 * taken from `onAfterRender`, plus the interaction state, taken from
 * `onViewStateChange`.
 */

import { WaterlinesDeckOverlay } from '../../src/adapters/deckgl.js';

const DATA_URL = new URL('../../data/indonesia-land.geojson', import.meta.url).href;

const INITIAL_VIEW_STATE = {
  longitude: 117.8,
  latitude: -2.2,
  zoom: 4.2,
  bearing: 0,
  // A 2D canvas has no perspective and the overlay's transform is affine, so
  // the demo stays flat. Bearing is fine - the affine picks up rotation.
  pitch: 0,
};

boot().catch((error) => {
  document.getElementById('loading').textContent = `Failed to start: ${error.message}`;
  throw error;
});

async function boot() {
  const response = await fetch(DATA_URL);
  if (!response.ok) {
    throw new Error(`could not load ${DATA_URL} (run "npm run data" to generate it)`);
  }
  const land = await response.json();

  const container = document.getElementById('deck-container');
  const overlay = new WaterlinesDeckOverlay({
    container,
    data: land,
    style: { preset: 'antique' },
    onFrame: (stats) => {
      document.getElementById('readout').textContent =
        `${stats.pending ? `refreshing ${Math.round(stats.progress * 100)}%` : stats.mode}` +
        `  ·  ${stats.rings} rings  ·  lod z${stats.lodZoom}`;
    },
  });

  let moving = false;

  const deckgl = new deck.DeckGL({
    parent: container,
    initialViewState: INITIAL_VIEW_STATE,
    controller: { dragRotate: true, touchRotate: true },
    layers: [
      new deck.GeoJsonLayer({
        id: 'land',
        data: land,
        filled: true,
        stroked: true,
        getFillColor: [239, 228, 200],
        getLineColor: [154, 135, 99, 190],
        lineWidthUnits: 'pixels',
        getLineWidth: 0.7,
      }),
    ],
    onViewStateChange: ({ interactionState }) => {
      moving = !!(
        interactionState.isDragging ||
        interactionState.isZooming ||
        interactionState.isPanning ||
        interactionState.isRotating
      );
    },
  });

  // Unlike MapLibre, deck does not emit a per-frame event you can rely on when
  // the view is still - it stops drawing once it has nothing to do. The
  // overlay needs a steady frame source of its own so a background refresh can
  // keep advancing, so it runs its own loop and reads deck's current viewport.
  // Syncing is cheap when nothing changed: the adapter compares transforms and
  // returns early.
  const frame = () => {
    const viewport = viewports(deckgl)[0];
    if (viewport) overlay.syncViewport(viewport, { moving });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  new ResizeObserver(() => overlay.syncSize()).observe(container);
  document.getElementById('loading').remove();
  window.__waterlinesDeck = { deckgl, overlay };
}

/** `getViewports` lives on the wrapper in some deck.gl builds, on `deck` in others. */
function viewports(deckgl) {
  if (typeof deckgl.getViewports === 'function') return deckgl.getViewports();
  if (deckgl.deck && typeof deckgl.deck.getViewports === 'function') {
    return deckgl.deck.getViewports();
  }
  return [];
}
