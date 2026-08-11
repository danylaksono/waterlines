/**
 * export-png.js
 *
 * Save what is on screen as a PNG.
 *
 * Three things make this less trivial than `canvas.toDataURL()`:
 *
 *  1. The picture is two canvases - MapLibre's WebGL one and the waterlines'
 *     own - which have to be composited in the right order.
 *  2. WebGL clears its drawing buffer after compositing unless the map was
 *     created with `preserveDrawingBuffer: true`. Without it the map layer
 *     reads back as transparent, so the studio page opts in. The waterlines
 *     overlay solves the same problem differently, through `snapshot()`, so
 *     that its own rendering stays fast - see `WaterlineGLEngine#snapshot`.
 *  3. The overlay may be sitting on a bitmap rendered at reduced resolution,
 *     or mid-refresh. Exporting has to wait for a full-quality one.
 *
 * Rendering above screen resolution works by growing the map container, which
 * is the only way to make MapLibre draw more pixels: it renders to its own
 * canvas at the size it is given. The container is restored afterwards.
 */

import { drawGrain, drawVignette } from '../../shared/js/paper.js';

/**
 * Composite the map and the waterlines into a fresh canvas, without saving it.
 * Useful for previews - and it is what {@link exportPng} encodes.
 *
 * @param {Object} options
 * @param {Object} options.map MapLibre map
 * @param {Object} options.overlay `WaterlinesOverlay`
 * @param {number} [options.scale=1] 1 = exactly what is on screen
 * @param {boolean} [options.grain=true] include the paper texture
 * @param {boolean} [options.vignette=true] include the corner darkening
 * @param {() => Promise<HTMLCanvasElement|null>} [options.underlay] resolved
 *   once the map is at its final size, and composited between the basemap and
 *   the waterlines. The hachures use it: they are a separate canvas rendered
 *   for a particular view, so at 2x and 3x they have to be rebuilt for the
 *   grown container rather than scaled up.
 * @param {(ctx:CanvasRenderingContext2D, width:number, height:number, k:number) => void} [options.decorate]
 *   painted last, over everything. `k` is device pixels per CSS pixel of the
 *   *on-screen* map, so a decoration can be placed and sized to match what the
 *   user sees at any export scale.
 * @param {(message:string) => void} [options.onProgress]
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderExportCanvas(options) {
  const {
    map,
    overlay,
    scale = 1,
    grain = true,
    vignette = true,
    underlay,
    decorate,
    onProgress = () => {},
  } = options;

  const cssWidth = map.getContainer().getBoundingClientRect().width;

  const container = map.getContainer();
  if (scale !== 1) assertWithinCanvasLimits(container, scale);
  const restore = scale === 1 ? null : growContainer(container, scale);

  try {
    if (restore) {
      onProgress('resizing the map…');
      map.resize();
      overlay.redraw();
      await waitForMapIdle(map);
    }

    let underlayCanvas = null;
    if (underlay) {
      onProgress('tracing hachures for the export size…');
      underlayCanvas = await underlay();
    }

    onProgress('rendering waterlines at full quality…');
    overlay.redraw();
    await waitForOverlay(overlay);
    // Draw the map once more immediately before reading it back. Even with
    // `preserveDrawingBuffer`, reading a buffer that was last written several
    // frames ago is not something to rely on.
    await waitForMapIdle(map);

    onProgress('compositing…');
    const mapCanvas = map.getCanvas();
    const width = mapCanvas.width;
    const height = mapCanvas.height;

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');

    ctx.drawImage(mapCanvas, 0, 0, width, height);

    // Between basemap and waterlines, the order they sit in on screen.
    if (underlayCanvas) ctx.drawImage(underlayCanvas, 0, 0, width, height);

    // `snapshot()` rather than the overlay's own canvas: on the distance-field
    // renderer the live canvas is a WebGL drawing buffer, which reads back as
    // transparent once the frame has been composited. Both renderers answer
    // this with a canvas that can be drawn from.
    const overlayCanvas = overlay.snapshot();
    if (overlayCanvas) {
      // The overlay's backing store follows its own pixel ratio, so let
      // drawImage rescale it to the map's.
      ctx.drawImage(overlayCanvas, 0, 0, width, height);
    }

    if (grain) drawGrain(ctx, width, height);
    if (vignette) drawVignette(ctx, width, height);
    // Device pixels per on-screen CSS pixel, so decorations keep the size and
    // inset they have on screen however far the export is scaled up.
    if (decorate) decorate(ctx, width, height, width / cssWidth);

    return out;
  } finally {
    if (restore) {
      restore();
      map.resize();
      overlay.redraw();
    }
  }
}

/**
 * Composite and save.
 *
 * @param {Object} options see {@link renderExportCanvas}, plus:
 * @param {string} [options.filename]
 * @returns {Promise<{width:number, height:number, filename:string}>}
 */
export async function exportPng(options) {
  const canvas = await renderExportCanvas(options);
  const filename = options.filename || defaultFilename(options.map);
  if (options.onProgress) options.onProgress('encoding…');
  await download(canvas, filename);
  return { width: canvas.width, height: canvas.height, filename };
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

/**
 * Fail early and clearly rather than handing the browser a canvas it will
 * silently refuse to allocate. Chrome caps a canvas at 16384 px on a side and
 * around 268 megapixels of area; the overlay's own buffer is larger still,
 * since it is padded around the viewport.
 */
function assertWithinCanvasLimits(container, scale) {
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = rect.width * scale * dpr;
  const height = rect.height * scale * dpr;
  const side = Math.max(width, height);
  const megapixels = (width * height) / 1e6;

  if (side > 16384 || megapixels > 260) {
    throw new Error(
      `${scale}x would need ${Math.round(width)}x${Math.round(height)} pixels ` +
        `(${megapixels.toFixed(0)} MP), beyond what a canvas can hold. ` +
        'Try a smaller window or a lower scale.'
    );
  }
}

/**
 * Grow the map container off-layout, and return an undo. The container is
 * pinned to the top-left so the extra pixels overflow out of view rather than
 * reflowing the page.
 */
function growContainer(container, scale) {
  const rect = container.getBoundingClientRect();
  const previous = container.getAttribute('style') || '';
  container.style.width = `${Math.round(rect.width * scale)}px`;
  container.style.height = `${Math.round(rect.height * scale)}px`;
  container.style.maxWidth = 'none';
  container.style.maxHeight = 'none';
  return () => container.setAttribute('style', previous);
}

/**
 * Resolve once the overlay is showing a finished, full-resolution bitmap.
 *
 * Polled on animation frames, because that is the only thing that advances a
 * background refresh. It waits for a run of consecutive settled frames rather
 * than for a single one: `redraw()` only marks the overlay dirty, so the
 * refresh does not begin until the next map frame, and checking once would
 * catch the gap before it started.
 */
function waitForOverlay(overlay, timeoutMs = 120000) {
  const SETTLED_FRAMES = 30;
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    let settled = 0;
    (function poll() {
      if (performance.now() > deadline) return resolve();
      if (overlay.getStats().pending) settled = 0;
      else if (++settled >= SETTLED_FRAMES) return resolve();
      requestAnimationFrame(poll);
    })();
  });
}

/** Resolve on the map's next idle, or after a timeout if it is already idle. */
function waitForMapIdle(map, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      map.off('idle', finish);
      resolve();
    };
    map.on('idle', finish);
    map.triggerRepaint();
    setTimeout(finish, timeoutMs);
  });
}

function download(canvas, filename) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('the browser refused to encode the PNG'));
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      resolve();
    }, 'image/png');
  });
}

function defaultFilename(map) {
  const { lng, lat } = map.getCenter();
  const zoom = map.getZoom().toFixed(1);
  return `waterlines_${lat.toFixed(3)}_${lng.toFixed(3)}_z${zoom}.png`;
}
