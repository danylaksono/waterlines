/**
 * gallery.js
 *
 * The technique with no map underneath - which is how the original Observable
 * notebook used it. Same renderer, same styles; only the transform differs
 * (fit-to-box instead of read-from-map).
 */

import { renderStill } from '../../src/still.js';
import { PRESETS } from '../../src/render/style.js';

// Resolved against this module's URL, so the page works from any path.
const DATASETS = {
  bali: { url: '../../data/bali-land.geojson', label: 'Bali & Lombok' },
  'raja-ampat': { url: '../../data/raja-ampat-land.geojson', label: 'Raja Ampat' },
};

const PLATES = [
  {
    dataset: 'bali',
    caption: 'Bali & Lombok - `classic`',
    style: { preset: 'classic', extent: 44, count: 12 },
  },
  {
    dataset: 'bali',
    caption: 'Bali & Lombok - `antique`, land drawn on the canvas',
    style: { preset: 'antique', land: 'fill', landColor: '#efe4c8', extent: 56 },
  },
  {
    dataset: 'raja-ampat',
    caption: 'Raja Ampat - `voronoi`: ripples meeting between islands',
    style: { preset: 'voronoi', land: 'fill', landColor: '#efe4c8', extent: 90, count: 20 },
  },
  {
    dataset: 'raja-ampat',
    caption: 'Raja Ampat - `bands`: filled instead of hollowed',
    style: { preset: 'bands', land: 'fill', landColor: '#efe4c8' },
  },
  {
    dataset: 'bali',
    caption:
      'Bali & Lombok - `curve: linear`. Compare the headlands with the plate above: ' +
      'a wide pen turns every sharp vertex into a spike',
    style: { preset: 'antique', land: 'fill', landColor: '#efe4c8', extent: 56 },
    curve: 'linear',
  },
  {
    dataset: 'bali',
    caption: 'Bali & Lombok - a single wide, sparse set of lines',
    style: { preset: 'nautical', land: 'fill', landColor: '#efe4c8', count: 6, extent: 70 },
  },
];

boot().catch((error) => {
  document.getElementById('gallery').textContent = `Failed: ${error.message}`;
  throw error;
});

async function boot() {
  const data = {};
  for (const [key, meta] of Object.entries(DATASETS)) {
    const url = new URL(meta.url, import.meta.url).href;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`could not load ${meta.url} - run "npm run data" first`);
    }
    data[key] = await response.json();
  }

  const root = document.getElementById('gallery');
  root.textContent = '';
  const size = 420;

  for (const plate of PLATES) {
    const figure = document.createElement('figure');
    const canvas = renderStill(data[plate.dataset], {
      width: size,
      height: size,
      pixelRatio: Math.min(devicePixelRatio || 1, 2),
      style: plate.style,
      curve: plate.curve,
    });
    figure.appendChild(canvas);

    const caption = document.createElement('figcaption');
    caption.innerHTML = plate.caption.replace(/`([^`]+)`/g, '<code>$1</code>');
    figure.appendChild(caption);
    root.appendChild(figure);
  }

  // Every preset at a glance.
  const strip = document.getElementById('presets');
  for (const name of Object.keys(PRESETS)) {
    const figure = document.createElement('figure');
    figure.appendChild(
      renderStill(data.bali, {
        width: 220,
        height: 220,
        pixelRatio: Math.min(devicePixelRatio || 1, 2),
        style: { preset: name, land: 'fill', landColor: '#efe4c8' },
      })
    );
    const caption = document.createElement('figcaption');
    caption.innerHTML = `<code>${name}</code>`;
    figure.appendChild(caption);
    strip.appendChild(figure);
  }
}
