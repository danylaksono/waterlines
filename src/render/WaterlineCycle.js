/**
 * WaterlineCycle.js
 *
 * One full loop of the waterline animation, precomputed as bitmaps.
 *
 * This is Olivia Vane's animation method
 * (https://observablehq.com/@oliviafvane/iv-animating-waterlines-canvas-strokes),
 * adapted to a view that can move. Her reasoning holds exactly: the animation
 * is a *loop*, so there are only N distinct pictures no matter how long it
 * runs, and rendering each one costs far too much to do per tick. Render them
 * once, then the animation is a sequence of `drawImage` calls - which cost
 * nothing - until the view changes and the loop has to be built again.
 *
 * Where it differs from the notebook: she renders once for a fixed 1200px
 * square and keeps the frames forever, so she can afford `getImageData` and a
 * plain `putImageData` per tick. Here the loop is tied to a viewport that pans
 * and zooms, so frames are kept as canvases (blittable through an affine, like
 * {@link RasterCache}) and the whole loop is discarded when the view moves far
 * enough that they no longer fit.
 *
 * The cost to be careful about is memory, not time: a loop is `frames` full
 * viewport bitmaps. At 1440x900 and `pixelRatio` 1 that is about 5 MB each, so
 * `budgetBytes` trims the frame count rather than letting a large window and a
 * long loop quietly allocate a gigabyte.
 */

import { blitTransform, entryCovers } from './RasterCache.js';

export class WaterlineCycle {
  /**
   * @param {Object} [options]
   * @param {number} [options.frames=12] pictures in one loop. More is smoother
   *   and proportionally more memory and build time; Vane uses 18.
   * @param {number} [options.pad=64] margin around the viewport, CSS px. Small
   *   on purpose - it is paid `frames` times over.
   * @param {number} [options.budgetBytes=192e6] ceiling on the whole loop;
   *   the frame count is reduced until it fits.
   * @param {number} [options.minScaleRatio=0.9]
   * @param {number} [options.maxScaleRatio=1.15]
   */
  constructor(options = {}) {
    this.frames = Math.max(2, Math.round(options.frames ?? 12));
    this.pad = options.pad ?? 64;
    this.budgetBytes = options.budgetBytes ?? 192e6;
    // Tighter than the raster cache's: a stretched bitmap is tolerable for the
    // duration of a gesture, but an animation sits there being looked at.
    this.minScaleRatio = options.minScaleRatio ?? 0.9;
    this.maxScaleRatio = options.maxScaleRatio ?? 1.15;

    /** @type {Array<Object>} finished frames, in phase order. */
    this.entries = [];
    /** @type {Object|null} loop under construction. */
    this.pending = null;
    /** How many loops have been completed. Monotonic; useful for tests. */
    this.builds = 0;
  }

  /** @returns {boolean} a complete loop is on hand. */
  get ready() {
    return this.entries.length > 0;
  }

  /** @returns {boolean} */
  get building() {
    return !!this.pending;
  }

  /** Progress of the loop under construction, 0..1. */
  get progress() {
    if (!this.pending) return 1;
    const { index, job, count } = this.pending;
    return (index + (job ? job.progress : 0)) / count;
  }

  /** Throw the loop away; the next {@link begin} rebuilds it. */
  invalidate() {
    this.entries = [];
    this.pending = null;
  }

  // ------------------------------------------------------------------------
  // build
  // ------------------------------------------------------------------------

  /**
   * Start building a loop for a view.
   *
   * The previous loop is dropped here rather than kept until this one is
   * finished, because the frame canvases are pooled and about to be drawn
   * over. Keeping it would mean a second set of `frames` bitmaps - the one
   * thing this class is trying not to allocate. So while a loop builds there
   * is nothing to play, and the caller shows its still bitmap instead: the
   * animation stops, then resumes, which is what {@link WaterlineEngine} does.
   *
   * @param {Object} spec
   * @param {import('./WaterlineRenderer.js').Affine} spec.matrix
   * @param {number} spec.width  viewport CSS px
   * @param {number} spec.height viewport CSS px
   * @param {number} spec.pixelRatio
   * @param {(ctx:CanvasRenderingContext2D, frame:Object, phase:number) => Object}
   *   spec.createJob given a context, `{matrix, width, height, pixelRatio}` and
   *   a phase in [0, 1), returns a job with `step()`, `done` and `progress`
   */
  begin(spec) {
    const { matrix, width, height, pixelRatio, createJob } = spec;
    const w = width + 2 * this.pad;
    const h = height + 2 * this.pad;
    const count = this.frameBudget(w, h, pixelRatio);

    this.entries = [];
    this.pending = {
      count,
      index: 0,
      job: null,
      entries: [],
      width: w,
      height: h,
      pixelRatio,
      matrix,
      // Rendered offset by the padding, so mercator lands inside the larger
      // canvas - same convention as RasterCache.
      offset: { ...matrix, e: matrix.e + this.pad, f: matrix.f + this.pad },
      createJob,
    };
  }

  /**
   * How many frames fit the memory budget at this size.
   *
   * @param {number} width  CSS px, padding included
   * @param {number} height CSS px, padding included
   * @param {number} pixelRatio
   * @returns {number} at least 2
   */
  frameBudget(width, height, pixelRatio) {
    const bytes = width * pixelRatio * height * pixelRatio * 4;
    if (!(bytes > 0)) return this.frames;
    return Math.max(2, Math.min(this.frames, Math.floor(this.budgetBytes / bytes)));
  }

  /**
   * Render part of the loop. Frames are built one at a time and a frame is
   * only usable once complete, so `steps` paces the work exactly as
   * {@link RasterCache#advance} does.
   *
   * @param {number} [steps=1]
   * @returns {boolean} true when the loop finished on this call
   */
  advance(steps = 1) {
    const pending = this.pending;
    if (!pending) return false;

    let budget = Math.max(1, steps);
    while (budget > 0) {
      if (!pending.job) {
        const phase = pending.index / pending.count;
        const entry = this._buffer(
          pending.entries.length,
          pending.width,
          pending.height,
          pending.pixelRatio
        );
        entry.matrix = pending.matrix;
        pending.entries.push(entry);
        pending.job = pending.createJob(
          entry.ctx,
          {
            matrix: pending.offset,
            width: pending.width,
            height: pending.height,
            pixelRatio: pending.pixelRatio,
          },
          phase
        );
      }

      while (budget > 0 && !pending.job.done) {
        pending.job.step();
        budget--;
      }
      if (!pending.job.done) return false;

      pending.job = null;
      pending.index++;
      if (pending.index >= pending.count) {
        this.entries = pending.entries;
        this.pending = null;
        this.builds++;
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------------
  // playback
  // ------------------------------------------------------------------------

  /**
   * Can the finished loop stand in for this view?
   *
   * @param {import('./WaterlineRenderer.js').Affine} matrix
   * @param {number} width
   * @param {number} height
   * @returns {boolean}
   */
  covers(matrix, width, height) {
    if (!this.ready) return false;
    return entryCovers(this.entries[0], matrix, width, height, this.pad, {
      min: this.minScaleRatio,
      max: this.maxScaleRatio,
    });
  }

  /** As {@link covers}, for the loop under construction. */
  jobCovers(matrix, width, height) {
    if (!this.pending) return false;
    return entryCovers(
      { matrix: this.pending.matrix, width: this.pending.width, height: this.pending.height },
      matrix,
      width,
      height,
      this.pad,
      { min: this.minScaleRatio, max: this.maxScaleRatio }
    );
  }

  /**
   * Which frame a clock reading lands on.
   *
   * @param {number} elapsedMs
   * @param {number} periodMs time for one full loop
   * @param {number} [direction=1] 1 runs the waterlines outwards, -1 inwards.
   *   Reversing really is only this: Vane's observation that the frames are the
   *   same either way, and only the order changes.
   * @returns {number}
   */
  frameAt(elapsedMs, periodMs, direction = 1) {
    const n = this.entries.length;
    if (!n) return 0;
    const turns = (elapsedMs / Math.max(1, periodMs)) * direction;
    const k = Math.floor(turns * n) % n;
    return k < 0 ? k + n : k;
  }

  /**
   * Paint one frame of the loop onto a destination context.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} index
   * @param {import('./WaterlineRenderer.js').Affine} matrix
   * @param {number} width  destination CSS width
   * @param {number} height destination CSS height
   * @param {number} pixelRatio destination backing-store ratio
   */
  blit(ctx, index, matrix, width, height, pixelRatio) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width * pixelRatio, height * pixelRatio);
    if (!this.ready) return;

    const n = this.entries.length;
    const entry = this.entries[((index % n) + n) % n];
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

  // ------------------------------------------------------------------------

  /**
   * A canvas for frame `i` of the loop under construction, reusing the one
   * from the previous loop where the geometry matches. Reallocating is
   * expensive enough to be worth avoiding: the first draw onto a fresh surface
   * costs markedly more than any later one, and here that penalty would be
   * paid once per frame of the loop.
   */
  _buffer(i, width, height, pixelRatio) {
    if (!this._pool) this._pool = [];
    let entry = this._pool[i];
    if (!entry) {
      const canvas = document.createElement('canvas');
      entry = {
        canvas,
        ctx: canvas.getContext('2d', { alpha: true, willReadFrequently: false }),
        width: -1,
        height: -1,
        pixelRatio: -1,
        matrix: null,
      };
      this._pool[i] = entry;
    }
    if (entry.width !== width || entry.height !== height || entry.pixelRatio !== pixelRatio) {
      entry.canvas.width = Math.max(1, Math.round(width * pixelRatio));
      entry.canvas.height = Math.max(1, Math.round(height * pixelRatio));
      entry.width = width;
      entry.height = height;
      entry.pixelRatio = pixelRatio;
    } else {
      entry.ctx.setTransform(1, 0, 0, 1, 0, 0);
      entry.ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
    }
    return entry;
  }
}
