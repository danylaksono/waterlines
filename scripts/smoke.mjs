/**
 * smoke.mjs
 *
 * End-to-end check in a real browser: loads every example, drives real input
 * events, and reports what the overlay actually costs.
 *
 * The interesting numbers are frame *intervals* during a synthesised drag,
 * with the overlay on and off. Anything else - in particular a stopwatch
 * around the drawing calls - measures command submission rather than
 * rasterisation and will happily report 0 ms for work that drops frames.
 *
 * Usage:
 *   node scripts/smoke.mjs           # GPU rasterisation (representative)
 *   node scripts/smoke.mjs --swift   # SwiftShader (pessimistic lower bound)
 *   node scripts/smoke.mjs --shots <dir>
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, sleep } from './browser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8123;
const BASE = `http://localhost:${PORT}`;

const args = process.argv.slice(2);
const useGpu = !args.includes('--swift');
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;

const VIEWS = [
  ['nusantara  z4.2', [117.8, -2.2], 4.2],
  ['sulawesi   z6.0', [121.0, -2.4], 6.0],
  ['bali       z8.3', [115.75, -8.5], 8.3],
  ['banda      z10.5', [129.89, -4.53], 10.5],
];

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

async function main() {
  const server = spawn(process.execPath, [join(ROOT, 'scripts', 'serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  if (shotsDir) await mkdir(shotsDir, { recursive: true });

  const browser = await launch({ width: 1440, height: 900, gpu: useGpu });
  console.log(`renderer: ${await rendererName(browser)}\n`);

  try {
    await maplibre(browser);
    await studio(browser);
    await deckgl(browser);
    await gallery(browser);
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

async function rendererName(browser) {
  await browser.goto('about:blank');
  return browser.evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'no webgl';
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  })()`);
}

// --------------------------------------------------------------------------

async function maplibre(browser) {
  console.log('-- examples/indonesia-maplibre.html');
  browser.errors.length = 0;
  await browser.goto(`${BASE}/examples/indonesia-maplibre.html`);
  await browser.waitFor('window.__waterlines && window.__waterlines.overlay', 40000);
  await settle(browser);

  const stats = JSON.parse(
    await browser.evaluate('JSON.stringify(window.__waterlines.overlay.getStats())')
  );
  check('overlay renders', stats.rings > 0, `${stats.rings} rings at lod z${stats.lodZoom}`);
  check('level of detail is simplified', stats.vertices < stats.sourceVertices,
    `${stats.vertices} of ${stats.sourceVertices} vertices`);

  await installFpsProbe(browser);

  for (const [label, center, zoom] of VIEWS) {
    await jump(browser, center, zoom, false);
    const off = await dragFrames(browser);
    await jump(browser, center, zoom, true);
    const on = await dragFrames(browser);
    // The overlay must not be the thing that limits the frame rate.
    check(
      `drag ${label}`,
      on.median <= Math.max(off.median * 1.6, off.median + 8),
      `overlay off ${off.median.toFixed(1)} ms, on ${on.median.toFixed(1)} ms ` +
        `(p90 ${on.p90.toFixed(1)} ms)`
    );
  }

  // Time from an invalidated overlay to a fully crisp bitmap at the heaviest view.
  await jump(browser, [117.8, -2.2], 4.2, true);
  await settle(browser);
  // The case that actually matters, and the easy one to test around by
  // accident: dragging while a refresh is in flight. A refresh must yield to
  // the gesture rather than compete with it for frames.
  await jump(browser, [117.8, -2.2], 4.2, true);
  await browser.evaluate('(() => { window.__waterlines.overlay.redraw(); return true; })()');
  const during = await dragFrames(browser);
  check(
    'drag during a refresh',
    during.median < 25,
    `${during.median.toFixed(1)} ms median, p90 ${during.p90.toFixed(1)} ms`
  );

  // Timed in the page: `redraw()` only marks the overlay dirty, so the refresh
  // starts on the next map frame. Polling from here would race it and report
  // the time before it began. Repeated, because the pacing controller's
  // starting point varies with what the previous frames were doing.
  // Timestamp each committed bitmap at the source. Polling for the transition
  // from the outside is unreliable: when frames are long, both commits can
  // land between two animation frames and the draft goes unobserved.
  await browser.evaluate(`(() => {
    const raster = window.__waterlines.overlay.engine.raster;
    if (raster.__instrumented) return true;
    raster.__instrumented = true;
    window.__commits = [];
    const advance = raster.advance.bind(raster);
    raster.advance = (gap, target) => {
      const done = advance(gap, target);
      if (done) window.__commits.push({ t: performance.now(), coarse: raster.current.coarse });
      return done;
    };
    return true;
  })()`);

  const drafts = [];
  const crisps = [];
  for (let i = 0; i < 3; i++) {
    // Two rungs: the draft that first puts waterlines on screen, and the full
    // resolution pass that replaces it.
    const run = JSON.parse(
      // Measured from a cold cache, which is what a user meets on load: with
      // nothing on screen the engine draws a fast draft first, then refines.
      // (Given a draft already showing it goes straight to full resolution, so
      // starting from a warm cache would measure a different thing.)
      // Polled on animation frames on purpose. Timestamping inside the engine
      // would record when the last drawing command was *submitted*, and a 2D
      // canvas rasterises later - so it would report tens of milliseconds for
      // work that takes seconds. An rAF loop is throttled by the same
      // rasterisation, which makes its elapsed time the honest one.
      await browser.evaluate(`new Promise((resolve) => {
        const overlay = window.__waterlines.overlay;
        const t0 = performance.now();
        window.__commits = [];
        overlay.engine.raster.invalidate();
        overlay.redraw();
        (function poll() {
          const now = Math.round(performance.now() - t0);
          const stats = overlay.getStats();
          const log = window.__commits;
          if (log.length && !stats.pending && !stats.draft) {
            return resolve(JSON.stringify({
              crisp: now,
              draftFirst: log[0].coarse === true,
              commits: log.length,
            }));
          }
          if (now > 60000) return resolve(JSON.stringify({ crisp: -1, draftFirst: false, commits: log.length }));
          requestAnimationFrame(poll);
        })();
      })`)
    );
    drafts.push(run.draftFirst && run.commits >= 2);
    crisps.push(run.crisp);
    await sleep(500);
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[1];
  check(
    'draws a draft before refining',
    drafts.every(Boolean),
    'from cold, the first bitmap committed is the fast low-detail one'
  );
  check(
    'refines to a crisp render',
    median(crisps) > 0 && median(crisps) < 6000,
    `${median(crisps)} ms median from cold (${crisps.join(', ')})`
  );

  // Rotation goes through the same affine; pitch does not, hence bearing only.
  await browser.evaluate(
    '(()=>{window.__waterlines.map.jumpTo({bearing:35});return true})()'
  );
  await settle(browser);
  const rotated = JSON.parse(
    await browser.evaluate('JSON.stringify(window.__waterlines.overlay.getStats())')
  );
  check('renders under a bearing', rotated.rings > 0, `${rotated.rings} rings at bearing 35`);
  await browser.evaluate('(()=>{window.__waterlines.map.jumpTo({bearing:0});return true})()');

  check('no console errors', pageErrors(browser).length === 0, pageErrors(browser)[0] || '');
  if (shotsDir) {
    await jump(browser, [119.75, -8.5], 8.8, true);
    await settle(browser);
    await browser.screenshot(join(shotsDir, 'maplibre-komodo.png'));
  }
}

async function studio(browser) {
  console.log('\n-- studio/index.html');
  browser.errors.length = 0;
  await browser.goto(`${BASE}/studio/index.html`);
  await browser.waitFor('window.__waterlinesStudio', 40000);
  await settleStudio(browser);

  // The invariant is that the shared sections are present, not that the studio
  // has no sections of its own.
  const sections = (
    await browser.evaluate(
      '[...document.querySelectorAll("#panel-body summary")].map(s => s.textContent).join(",")'
    )
  ).split(',');
  check(
    'shares the waterline panel with the main example',
    ['Waterlines', 'Performance'].every((s) => sections.includes(s)),
    sections.join(' | ')
  );

  // A hosted third-party style: the point is that the overlay tracks a basemap
  // built from geometry it has never seen.
  await browser.evaluate(`(() => {
    const select = [...document.querySelectorAll('#panel-body select')]
      .find((s) => [...s.options].some((o) => o.value === 'woodblock'));
    select.value = 'woodblock';
    select.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(6000);
  await settleStudio(browser);
  const woodblock = JSON.parse(
    await browser.evaluate('JSON.stringify(window.__waterlinesStudio.overlay.getStats())')
  );
  check('renders over the Woodblock basemap', woodblock.rings > 0, `${woodblock.rings} rings`);

  // Upload: a grid of blobs, nothing like a coastline.
  const good = join(tmpdir(), 'waterlines-smoke-good.geojson');
  const bad = join(tmpdir(), 'waterlines-smoke-bad.geojson');
  await writeFile(good, JSON.stringify(blobGrid()));
  await writeFile(bad, JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }],
  }));

  await setFile(browser, '.dropzone .file', good);
  await sleep(3500);
  const uploaded = JSON.parse(
    await browser.evaluate('JSON.stringify(window.__waterlinesStudio.overlay.getStats())')
  );
  check('draws uploaded GeoJSON', uploaded.rings === 12, `${uploaded.rings} rings from the upload`);
  check(
    'frames the uploaded data',
    Math.abs(Number(await browser.evaluate('window.__waterlinesStudio.map.getCenter().lat')) - 45.4) < 1.5,
    'fitBounds moved the camera to the data'
  );

  await setFile(browser, '.dropzone .file', bad);
  await sleep(1500);
  const message = await browser.evaluate('document.getElementById("data-status").textContent');
  const kept = JSON.parse(
    await browser.evaluate('JSON.stringify(window.__waterlinesStudio.overlay.getStats())')
  );
  check('rejects data with no polygons', /no polygons/.test(message) && kept.rings === 12,
    'and keeps what was already loaded');

  // Export: run the page's own compositing code and inspect the pixels, rather
  // than trusting a success message. A headless download cannot be opened.
  await settleStudio(browser);
  const composite = JSON.parse(await browser.evaluate(`(async () => {
    const { renderExportCanvas } = await import('/studio/js/export-png.js');
    const s = window.__waterlinesStudio;
    const canvas = await renderExportCanvas({ map: s.map, overlay: s.overlay });
    const ctx = canvas.getContext('2d');
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    let total = 0;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4000) {
      total++;
      if (px[i + 3] > 250) opaque++;
      // Waterline ink is darker than both the sea and the land fill.
      if (px[i] < 150 && px[i + 1] < 150) ink++;
    }
    return JSON.stringify({
      w: canvas.width, h: canvas.height,
      opaque: opaque / total, ink: ink / total,
    });
  })()`));
  check(
    'export composite is fully painted',
    composite.opaque > 0.99,
    `${composite.w}x${composite.h}, map pixels survive readback`
  );
  check('export contains waterline ink', composite.ink > 0.001,
    `${(composite.ink * 100).toFixed(1)}% of sampled pixels are ink`);

  // The wind rose: on screen, turning with the bearing, and in the export.
  const rose = JSON.parse(await browser.evaluate(`(async () => {
    const { renderExportCanvas } = await import('/studio/js/export-png.js');
    const s = window.__waterlinesStudio;
    const canvas = document.querySelector('#compass canvas');

    const shot = () => {
      const c = canvas.getContext('2d');
      const d = c.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 40) sum += d[i] * (i % 977);
      return sum;
    };

    s.map.jumpTo({ bearing: 0 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const north = shot();
    s.map.jumpTo({ bearing: 40 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const turned = shot();
    s.map.jumpTo({ bearing: 0 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Sample the corner the rose occupies, with and without the decoration.
    const sample = (c) => {
      const ctx = c.getContext('2d');
      const k = c.width / s.map.getContainer().getBoundingClientRect().width;
      const px = ctx.getImageData(
        Math.round(c.width - 80 * k), Math.round(c.height - 120 * k), 1, 1
      ).data;
      return [px[0], px[1], px[2]].join(',');
    };
    const plain = sample(await renderExportCanvas({ map: s.map, overlay: s.overlay }));
    const withRose = sample(
      await renderExportCanvas({ map: s.map, overlay: s.overlay, decorate: s.paintCompass })
    );

    // Placement must move it on screen and in the export alike.
    const box = () => {
      const r = document.getElementById('compass').getBoundingClientRect();
      const m = s.map.getContainer().getBoundingClientRect();
      return Math.round(r.left - m.left) + ',' + Math.round(r.top - m.top);
    };
    const atBottomRight = box();

    // Offset: away from both edges of the corner at once, screen and export.
    s.compass.setInset(60);
    const atInset60 = box();
    const insetInExport = sample(
      await renderExportCanvas({ map: s.map, overlay: s.overlay, decorate: s.paintCompass })
    );
    s.compass.setInset(18);

    s.compass.setPlacement('top-left');
    const atTopLeft = box();
    const movedInExport = sample(
      await renderExportCanvas({ map: s.map, overlay: s.overlay, decorate: s.paintCompass })
    );
    s.compass.setPlacement('off');
    const hidden = document.getElementById('compass').style.display === 'none';
    const offInExport = sample(
      await renderExportCanvas({ map: s.map, overlay: s.overlay, decorate: s.paintCompass })
    );
    s.compass.setPlacement('bottom-right');

    return JSON.stringify({
      present: !!canvas,
      size: canvas ? canvas.width + 'x' + canvas.height : null,
      rotates: north !== turned,
      inExport: plain !== withRose,
      moves: atBottomRight !== atTopLeft,
      movesInExport: movedInExport !== withRose,
      hidden,
      offMatchesPlain: offInExport === plain,
      corners: atBottomRight + ' -> ' + atTopLeft,
      insetMoves: atBottomRight !== atInset60,
      insetInExport: insetInExport !== withRose,
      insets: atBottomRight + ' -> ' + atInset60,
    });
  })()`));
  check('wind rose is drawn', rose.present, rose.size);
  check('wind rose turns with the bearing', rose.rotates);
  check('wind rose reaches the export', rose.inExport);
  check('placement moves it on screen', rose.moves, rose.corners);
  check('placement moves it in the export', rose.movesInExport);
  check('placement "off" hides it everywhere', rose.hidden && rose.offMatchesPlain);
  check('edge offset moves it on screen', rose.insetMoves, rose.insets);
  check('edge offset moves it in the export', rose.insetInExport);

  // The rhumb network. Unlike the rose in the corner this is MapLibre
  // geometry, so the checks are about layers existing, the controls reaching
  // them, and the lines arriving in the export through the map canvas.
  const rhumb = JSON.parse(await browser.evaluate(`(async () => {
    const { renderExportCanvas } = await import('/studio/js/export-png.js');
    const s = window.__waterlinesStudio;
    const body = [...document.querySelectorAll('#panel-body details')]
      .find((d) => d.querySelector('summary').textContent === 'Rhumb lines')
      .querySelector('.section__body');
    const mode = (v) => body.querySelector('button[data-value="' + v + '"]').click();
    const layers = () =>
      ['rhumb-principal', 'rhumb-half', 'rhumb-quarter'].filter((id) => s.map.getLayer(id)).length;

    s.rhumbPanel.set('enabled', true);
    const single = s.rhumb.getStats().features;
    const added = layers();

    s.rhumbPanel.set('quarter', false);
    const noQuarter = s.rhumb.getStats().features;
    s.rhumbPanel.set('quarter', true);

    mode('lattice');
    const lattice = s.rhumb.getStats().features;
    mode('single');

    const status = document.getElementById('rhumb-status').textContent;

    // The lines are hairlines at partial opacity, so counting "reddish" pixels
    // is at the mercy of the threshold. Differencing two exports is not: only
    // the network changed between them.
    const shot = async () => {
      const canvas = await renderExportCanvas({ map: s.map, overlay: s.overlay });
      return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const withLines = await shot();
    s.rhumbPanel.set('enabled', false);
    const bare = await shot();
    const removed = layers();
    s.rhumbPanel.set('enabled', true);

    let changed = 0;
    let samples = 0;
    for (let i = 0; i < withLines.length; i += 40) {
      samples++;
      if (Math.abs(withLines[i] - bare[i]) > 12) changed++;
    }

    return JSON.stringify({
      single, noQuarter, lattice, added, removed, status,
      changed: changed / samples,
      anchored: s.rhumb.getStats().center,
    });
  })()`));
  check('one rose is the historical 136 lines', rhumb.single === 136 && rhumb.added === 3,
    `${rhumb.single} lines across ${rhumb.added} layers`);
  check('dropping the quarter winds halves it', rhumb.noQuarter === 72, `${rhumb.noQuarter} lines`);
  // How many cells land in the window depends on the window, so the invariant
  // is whole systems repeating, not a count.
  check('the lattice repeats the system', rhumb.lattice > rhumb.single && rhumb.lattice % 136 === 0,
    `${rhumb.lattice / 136} roses across the view`);
  check('the rose is anchored on the view', Math.abs(rhumb.anchored[1] - 45.4) < 2,
    rhumb.anchored.map((v) => v.toFixed(1)).join(', '));
  check('reports what it drew', /136 lines, centred/.test(rhumb.status), rhumb.status);
  check('rhumb lines reach the export', rhumb.changed > 0.002,
    `${(rhumb.changed * 100).toFixed(1)}% of sampled pixels differ from an export without them`);
  check('switching it off removes the layers', rhumb.removed === 0);

  // A style swap throws away everything added on top of it, so the network has
  // to put itself back.
  await browser.evaluate(`(() => {
    const select = [...document.querySelectorAll('#panel-body select')]
      .find((s) => [...s.options].some((o) => o.value === 'paper'));
    select.value = 'paper';
    select.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(4000);
  await settleStudio(browser);
  const survived = JSON.parse(await browser.evaluate(`(() => {
    const s = window.__waterlinesStudio;
    return JSON.stringify({
      layers: ['rhumb-principal', 'rhumb-half', 'rhumb-quarter']
        .filter((id) => s.map.getLayer(id)).length,
      features: s.rhumb.getStats().features,
    });
  })()`));
  check('rhumb lines survive a basemap swap', survived.layers === 3 && survived.features === 136,
    `${survived.features} lines back across ${survived.layers} layers`);

  // Folding the panel away, so the map can be framed without the controls.
  const toggle = JSON.parse(await browser.evaluate(`(() => {
    const panel = document.getElementById('panel');
    const button = document.getElementById('panel-toggle');
    const body = document.getElementById('panel-body');
    const open = panel.getBoundingClientRect().height;

    button.click();
    const collapsed = panel.getBoundingClientRect().height;
    const bodyHidden = getComputedStyle(body).display === 'none';
    const stillReachable = button.getBoundingClientRect().width > 0;

    // The keyboard route, which must work with nothing focused.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    const reopened = panel.getBoundingClientRect().height;

    return JSON.stringify({
      collapses: collapsed < open * 0.5 && bodyHidden,
      stillReachable,
      restores: Math.abs(reopened - open) < 1,
      sizes: Math.round(open) + 'px -> ' + Math.round(collapsed) + 'px',
    });
  })()`));
  check('panel toggle folds the controls away', toggle.collapses, toggle.sizes);
  check('the toggle stays on screen when collapsed', toggle.stillReachable);
  check('H restores the panel', toggle.restores);

  // And the real button, end to end.
  await browser.evaluate('(() => { document.getElementById("export-button").click(); return true; })()');
  await browser.waitFor('/saved |failed/.test(document.getElementById("export-status").textContent)', 60000);
  const status = await browser.evaluate('document.getElementById("export-status").textContent');
  check('save PNG completes', status.startsWith('saved '), status);

  check('no console errors', pageErrors(browser).length === 0, pageErrors(browser)[0] || '');
  if (shotsDir) await browser.screenshot(join(shotsDir, 'studio.png'));

  await rm(good, { force: true });
  await rm(bad, { force: true });
}

async function deckgl(browser) {
  console.log('\n-- examples/indonesia-deckgl.html');
  browser.errors.length = 0;
  await browser.goto(`${BASE}/examples/indonesia-deckgl.html`);
  await browser.waitFor('window.__waterlinesDeck', 40000);
  await browser.waitFor('!window.__waterlinesDeck.overlay.getStats().pending', 60000);

  const stats = JSON.parse(
    await browser.evaluate('JSON.stringify(window.__waterlinesDeck.overlay.getStats())')
  );
  check('overlay renders over deck.gl', stats.rings > 0, `${stats.rings} rings`);
  check('no console errors', pageErrors(browser).length === 0, pageErrors(browser)[0] || '');
  if (shotsDir) await browser.screenshot(join(shotsDir, 'deckgl.png'));
}

async function gallery(browser) {
  console.log('\n-- examples/still-gallery.html');
  browser.errors.length = 0;
  await browser.goto(`${BASE}/examples/still-gallery.html`);
  await sleep(4000);

  const counts = await browser.evaluate(
    'document.querySelectorAll("#gallery canvas").length + "," + document.querySelectorAll("#presets canvas").length'
  );
  const [plates, presets] = counts.split(',').map(Number);
  check('plates rendered', plates >= 6, `${plates} plates`);
  check('preset strip rendered', presets >= 5, `${presets} presets`);
  check('no console errors', pageErrors(browser).length === 0, pageErrors(browser)[0] || '');
  if (shotsDir) await browser.screenshot(join(shotsDir, 'gallery.png'));
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/**
 * Console errors that are ours to answer for.
 *
 * Errors naming a third-party host are split out and reported as notes rather
 * than failures. The Woodblock basemap pulls tiles from a public server that
 * intermittently returns a response without CORS headers; that is a real
 * property of depending on someone else's tiles, but it is not a defect in
 * this code and should not turn the suite red.
 */
function pageErrors(browser) {
  const external = [];
  const own = [];
  for (const error of browser.errors) {
    const remote = /https?:\/\/(?!localhost|127\.0\.0\.1)/.test(error);
    (remote ? external : own).push(error);
  }
  for (const note of external) {
    console.log(`note  third-party request failed  ${firstLine(note)}`);
  }
  return own;
}

function firstLine(text) {
  return String(text).split('\n')[0].slice(0, 150);
}

async function settle(browser) {
  await sleep(600);
  await browser
    .waitFor('!window.__waterlines || !window.__waterlines.overlay.getStats().pending', 60000)
    .catch(() => {});
  await sleep(400);
}

async function settleStudio(browser) {
  await sleep(600);
  await browser
    .waitFor('!window.__waterlinesStudio.overlay.getStats().pending', 60000)
    .catch(() => {});
  await sleep(400);
}

/** Drive a real `<input type="file">`, the way the page expects to be used. */
async function setFile(browser, selector, path) {
  await browser.send('DOM.enable');
  const { root } = await browser.send('DOM.getDocument');
  const { nodeId } = await browser.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error(`no element matched ${selector}`);
  await browser.send('DOM.setFileInputFiles', { nodeId, files: [path] });
}

/** Twelve blobs on a grid near Verona - deliberately not a coastline. */
function blobGrid() {
  const features = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      const cx = 10.4 + i * 0.4;
      const cy = 45.0 + j * 0.4;
      const r = 0.07 + ((i + j) % 3) * 0.03;
      const ring = [];
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        ring.push([
          Number((cx + r * Math.cos(a) * 1.5).toFixed(5)),
          Number((cy + r * Math.sin(a)).toFixed(5)),
        ]);
      }
      ring.push(ring[0]);
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

async function jump(browser, center, zoom, visible) {
  await browser.evaluate(`(() => {
    const s = window.__waterlines;
    s.map.jumpTo({ center: [${center[0]}, ${center[1]}], zoom: ${zoom} });
    s.overlay.setVisible(${visible});
    return true;
  })()`);
  await settle(browser);
}

async function installFpsProbe(browser) {
  await browser.evaluate(`(() => {
    window.__fps = { t: [], on: false };
    (function loop() {
      if (window.__fps.on) window.__fps.t.push(performance.now());
      requestAnimationFrame(loop);
    })();
    return true;
  })()`);
}

/** Synthesise a drag and report the frame-interval distribution during it. */
async function dragFrames(browser) {
  await browser.evaluate('window.__fps.t = []; window.__fps.on = true; true');

  await browser.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: 900, y: 450, button: 'left', clickCount: 1, buttons: 1,
  });
  for (let i = 1; i <= 25; i++) {
    await browser.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 900 - i * 8,
      y: 450 + Math.round(Math.sin(i / 4) * 25),
      button: 'left',
      buttons: 1,
    });
    await sleep(30);
  }
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: 700, y: 450, button: 'left', buttons: 0,
  });

  await browser.evaluate('window.__fps.on = false; true');
  const raw = await browser.evaluate(`(() => {
    const t = window.__fps.t;
    const d = [];
    for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
    d.sort((a, b) => a - b);
    const at = (q) => (d.length ? d[Math.min(d.length - 1, Math.floor(d.length * q))] : 0);
    return JSON.stringify({ frames: t.length, median: at(0.5), p90: at(0.9) });
  })()`);
  return JSON.parse(raw);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
