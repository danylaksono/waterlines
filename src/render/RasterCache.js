/**
 * RasterCache.js
 *
 * The bitmap the overlay actually shows, and how it gets refreshed.
 *
 * Why this exists, in numbers. The technique's cost is not vertices, it is
 * *rasterised area*: each of the N passes paints a band roughly `2 * extent`
 * wide along the whole visible coastline, twice - once to draw, once to erase.
 * Measured on a software rasteriser at 1440x900, the whole Indonesian
 * archipelago at zoom 4 with the `antique` preset takes ~1.2 s for one frame.
 * A GPU-backed canvas is far quicker, but never quick enough for 60 fps, and
 * no amount of geometry optimisation touches it - the pixels are the cost.
 *
 * Two ideas make it interactive anyway, both borrowed from how tiled maps
 * behave:
 *
 *  1. **Reuse.** At a fixed zoom and bearing the waterline image is *rigid*
 *     under panning - the same picture, translated. So it is rendered once
 *     into a canvas slightly larger than the viewport and, while the view only
 *     slides within that margin, blitted. Zoom and rotation go through the
 *     same blit with a full affine; line widths scale with the gesture, which
 *     is wrong, but it is only ever seen mid-gesture.
 *
 *  2. **Show stale, render fresh.** A refresh runs a few steps per frame into
 *     a second, hidden canvas while the previous bitmap stays on screen. The
 *     map never waits for the waterlines. When the new bitmap is complete the
 *     two swap. A half-finished waterline render is not a valid picture (see
 *     `WaterlineDrawJob`), which is exactly why it is never displayed.
 */

import { matrixScale } from './WaterlineRenderer.js';

export class RasterCache {
  /**
   * @param {Object} [options]
   * @param {number} [options.pad=192] margin around the viewport, CSS px.
   *   Bigger means fewer refreshes while panning, and more pixels per refresh.
   * @param {number} [options.minScaleRatio=0.75] below this the bitmap is too
   *   small to cover the viewport
   * @param {number} [options.maxScaleRatio=1.8] above this it is visibly soft
   */
  constructor(options = {}) {
    this.pad = options.pad ?? 192;
    this.minScaleRatio = options.minScaleRatio ?? 0.75;
    this.maxScaleRatio = options.maxScaleRatio ?? 1.8;

    /** Bitmap currently on screen. */
    this.current = null;
    /** Bitmap being rendered. */
    this.pending = null;
    /** Steps to run per frame; steered by the observed frame interval. */
    this.stepsPerFrame = 1;
    /** How many bitmaps have been swapped in. Monotonic; useful for tests. */
    this.commits = 0;
  }

  /** @returns {boolean} */
  get hasCurrent() {
    return !!(this.current && this.current.matrix);
  }

  /** @returns {boolean} */
  get hasJob() {
    return !!this.pending;
  }

  /** True when the visible bitmap was rendered at reduced resolution. */
  get isCoarse() {
    return !!(this.current && this.current.coarse);
  }

  /** Progress of the in-flight refresh, 0..1. */
  get progress() {
    return this.pending ? this.pending.job.progress : 1;
  }

  /** Throw everything away; the next frame must refresh. */
  invalidate() {
    this.current = null;
    this.pending = null;
  }

  // ------------------------------------------------------------------------
  // refresh
  // ------------------------------------------------------------------------

  /**
   * Start rendering a new bitmap. Any in-flight refresh is abandoned.
   *
   * @param {Object} spec
   * @param {import('./WaterlineRenderer.js').Affine} spec.matrix
   * @param {number} spec.width  viewport CSS px
   * @param {number} spec.height viewport CSS px
   * @param {number} spec.pixelRatio
   * @param {boolean} spec.coarse mark the result as reduced quality
   * @param {(ctx:CanvasRenderingContext2D, frame:Object) => Object} spec.createJob
   *   given a context and `{matrix, width, height, pixelRatio}`, returns a job
   *   with `step()`, `done` and `progress`
   */
  begin(spec) {
    const { matrix, width, height, pixelRatio, coarse, createJob } = spec;
    const w = width + 2 * this.pad;
    const h = height + 2 * this.pad;

    // Draw into whichever of the two pooled buffers is not on screen. Canvas
    // allocation is expensive - the first draw onto a fresh surface costs far
    // more than any subsequent one - so the pool never grows past two, even
    // when a gesture abandons refresh after refresh.
    const index = this._takeBuffer(w, h, pixelRatio);
    const buffer = this._pool[index];
    // Render offset by the padding so mercator lands inside the larger canvas.
    const offset = { ...matrix, e: matrix.e + this.pad, f: matrix.f + this.pad };

    this.pending = {
      index,
      canvas: buffer.canvas,
      ctx: buffer.ctx,
      width: w,
      height: h,
      pixelRatio,
      matrix,
      coarse,
      job: createJob(buffer.ctx, {
        matrix: offset,
        width: w,
        height: h,
        pixelRatio,
      }),
    };
  }

  /**
   * Run part of the in-flight refresh, then swap it in if it finished.
   *
   * Pacing is a feedback loop over the *observed frame interval*, not over a
   * stopwatch around the drawing calls. Two reasons: a 2D canvas only records
   * commands and rasterises later, so timing `stroke()` measures nothing; and
   * forcing a flush to make it measurable - a 1x1 `getImageData` - turns out
   * to be ruinous, costing more than the drawing it was meant to measure. The
   * cost of frame N therefore shows up as a long interval before frame N+1,
   * which is exactly the signal to steer on.
   *
   * @param {number} frameGapMs interval since the previous frame
   * @param {number} targetMs frame interval to aim for
   * @returns {boolean} true when the refresh completed on this call
   */
  advance(frameGapMs, targetMs) {
    const pending = this.pending;
    if (!pending) return false;

    // Multiplicative increase, multiplicative decrease. Additive stepping is
    // too timid: a job of twenty passes would spend twenty frames climbing to
    // a rate it could have reached in five, and the whole refresh takes an
    // order of magnitude longer than the hardware needs.
    if (frameGapMs > 0) {
      if (frameGapMs > targetMs * 1.3) {
        this.stepsPerFrame = Math.max(1, Math.floor(this.stepsPerFrame * 0.6));
      } else if (frameGapMs < targetMs) {
        this.stepsPerFrame = Math.min(
          48,
          this.stepsPerFrame + Math.max(1, Math.floor(this.stepsPerFrame * 0.5))
        );
      }
    }

    let steps = 0;
    while (!pending.job.done && steps < this.stepsPerFrame) {
      pending.job.step();
      steps++;
    }

    if (!pending.job.done) return false;

    this.current = pending;
    this.pending = null;
    this.commits++;
    return true;
  }

  // ------------------------------------------------------------------------
  // reuse
  // ------------------------------------------------------------------------

  /**
   * Can the visible bitmap stand in for this view?
   *
   * @param {import('./WaterlineRenderer.js').Affine} matrix
   * @param {number} width  viewport CSS px
   * @param {number} height viewport CSS px
   * @returns {boolean}
   */
  covers(matrix, width, height) {
    return this._covers(this.current, matrix, width, height);
  }

  /** As {@link covers}, but for the bitmap being rendered. */
  jobCovers(matrix, width, height) {
    return this.pending ? this._covers(this.pending, matrix, width, height) : false;
  }

  _covers(entry, matrix, width, height) {
    return entryCovers(entry, matrix, width, height, this.pad, {
      min: this.minScaleRatio,
      max: this.maxScaleRatio,
    });
  }

  /**
   * Paint the visible bitmap onto a destination context.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('./WaterlineRenderer.js').Affine} matrix
   * @param {number} width  destination CSS width
   * @param {number} height destination CSS height
   * @param {number} pixelRatio destination backing-store ratio
   */
  blit(ctx, matrix, width, height, pixelRatio) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width * pixelRatio, height * pixelRatio);
    if (!this.hasCurrent) return;

    const entry = this.current;
    const t = blitTransform(entry, matrix, this.pad);
    ctx.setTransform(
      t.a * pixelRatio,
      t.b * pixelRatio,
      t.c * pixelRatio,
      t.d * pixelRatio,
      t.e * pixelRatio,
      t.f * pixelRatio
    );
    ctx.drawImage(entry.canvas, 0, 0, entry.width, entry.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Index of a drawable buffer: the pooled one that is not currently on
   * screen, resized if the geometry changed.
   *
   * @returns {number} 0 or 1
   */
  _takeBuffer(width, height, pixelRatio) {
    if (!this._pool) this._pool = [null, null];

    const index = this.current && this.current.index === 0 ? 1 : 0;

    let entry = this._pool[index];
    if (!entry) {
      const canvas = document.createElement('canvas');
      entry = {
        canvas,
        ctx: canvas.getContext('2d', { alpha: true, willReadFrequently: false }),
        width: -1,
        height: -1,
        pixelRatio: -1,
      };
      this._pool[index] = entry;
    }

    if (
      entry.width !== width ||
      entry.height !== height ||
      entry.pixelRatio !== pixelRatio
    ) {
      entry.canvas.width = Math.max(1, Math.round(width * pixelRatio));
      entry.canvas.height = Math.max(1, Math.round(height * pixelRatio));
      entry.width = width;
      entry.height = height;
      entry.pixelRatio = pixelRatio;
    }
    return index;
  }
}

// --------------------------------------------------------------------------
// shared with WaterlineCycle, which holds a whole animation loop of bitmaps
// rendered for one view and needs exactly the same reuse arithmetic.
// --------------------------------------------------------------------------

/**
 * Affine mapping a bitmap's CSS coordinates onto the current screen.
 *
 * A mercator point sat at `s0 = A0 p + t0` when the bitmap was made and
 * belongs at `s = A p + t` now, so `s = L s0 + (t - L t0)` with
 * `L = A A0^-1`. The bitmap's own origin is offset by the padding.
 *
 * @param {{matrix:import('./WaterlineRenderer.js').Affine}} entry
 * @param {import('./WaterlineRenderer.js').Affine} matrix
 * @param {number} pad
 * @returns {import('./WaterlineRenderer.js').Affine}
 */
export function blitTransform(entry, matrix, pad) {
  const m0 = entry.matrix;
  const det0 = m0.a * m0.d - m0.c * m0.b;

  const ia = m0.d / det0;
  const ib = -m0.b / det0;
  const ic = -m0.c / det0;
  const id = m0.a / det0;

  // L = A * A0^-1, in the canvas column convention [[a, c], [b, d]].
  const la = matrix.a * ia + matrix.c * ib;
  const lb = matrix.b * ia + matrix.d * ib;
  const lc = matrix.a * ic + matrix.c * id;
  const ld = matrix.b * ic + matrix.d * id;

  const tx = matrix.e - (la * m0.e + lc * m0.f);
  const ty = matrix.f - (lb * m0.e + ld * m0.f);

  return {
    a: la,
    b: lb,
    c: lc,
    d: ld,
    e: tx - (la + lc) * pad,
    f: ty - (lb + ld) * pad,
  };
}

/**
 * Can a bitmap rendered for one view stand in for another?
 *
 * @param {Object} entry bitmap record with `matrix`, `width`, `height` (CSS px,
 *   padding included)
 * @param {import('./WaterlineRenderer.js').Affine} matrix
 * @param {number} width  viewport CSS px
 * @param {number} height viewport CSS px
 * @param {number} pad
 * @param {{min:number, max:number}} [scaleRatio] tolerated rescale range
 * @returns {boolean}
 */
export function entryCovers(entry, matrix, width, height, pad, scaleRatio = {}) {
  if (!entry || !entry.matrix) return false;
  if (entry.width !== width + 2 * pad) return false;
  if (entry.height !== height + 2 * pad) return false;

  const { min = 0.75, max = 1.8 } = scaleRatio;
  const ratio = matrixScale(matrix) / matrixScale(entry.matrix);
  if (ratio < min || ratio > max) return false;

  const t = blitTransform(entry, matrix, pad);
  const det = t.a * t.d - t.c * t.b;
  if (!det) return false;

  for (const [sx, sy] of [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ]) {
    const qx = sx - t.e;
    const qy = sy - t.f;
    const u = (t.d * qx - t.c * qy) / det;
    const v = (-t.b * qx + t.a * qy) / det;
    if (u < 0 || v < 0 || u > entry.width || v > entry.height) return false;
  }
  return true;
}
