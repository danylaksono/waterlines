/**
 * WaterlineRenderer.js
 *
 * The technique, in one place.
 *
 * Ported from Olivia Vane's "Drawing waterlines on maps"
 * (https://observablehq.com/@oliviafvane/ii-drawing-waterlines-on-maps),
 * specifically her `draw_map_canvas_stroke` cell, which is the fast variant:
 * instead of computing N geometric buffers with turf (seconds per frame), it
 * strokes *one* coastline path N times with a decreasing pen width, and after
 * each stroke erases a slightly narrower stroke with
 * `globalCompositeOperation = 'destination-out'`. What survives each pass is a
 * thin ring at a known offset from the shore - a waterline - and the whole
 * thing is pure rasterisation, so it is fast enough to run every frame.
 *
 * This class is deliberately map-agnostic: it takes a `Path2D`, an affine
 * transform and a style, and draws. `adapters/maplibre.js` supplies those from
 * a live map; `adapters/deckgl.js` does the same for a deck.gl viewport.
 */

import { powScale } from './scales.js';
import { colorAccessor, resolveStyle } from './style.js';

/**
 * @typedef {Object} Affine
 * @property {number} a
 * @property {number} b
 * @property {number} c
 * @property {number} d
 * @property {number} e
 * @property {number} f
 */

/**
 * Uniform scale factor of an affine transform (px per mercator unit).
 *
 * @param {Affine} m
 * @returns {number}
 */
export function matrixScale(m) {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

export class WaterlineRenderer {
  /**
   * @param {Partial<import('./style.js').WaterlineStyle> & {preset?:string}} [style]
   */
  constructor(style) {
    this.style = resolveStyle(style);
    this._colorAt = colorAccessor(this.style.color);
    /** Timing of the last draw, in ms. */
    this.lastDrawMs = 0;
  }

  /**
   * Replace the style. Cheap; safe to call per frame from a UI control.
   *
   * @param {Partial<import('./style.js').WaterlineStyle> & {preset?:string}} style
   */
  setStyle(style) {
    this.style = resolveStyle({ ...this.style, ...style });
    this._colorAt = colorAccessor(this.style.color);
  }

  /**
   * Split a frame into steps that can be executed across several animation
   * frames. A full continental view can cost hundreds of milliseconds to
   * rasterise; running it in one go would drop that many frames, so the engine
   * renders into an off-screen bitmap a few steps at a time and keeps showing
   * the previous one until the new one is finished.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} frame see {@link WaterlineRenderer#draw}
   * @returns {WaterlineDrawJob}
   */
  createJob(ctx, frame) {
    return new WaterlineDrawJob(this, ctx, frame);
  }

  /**
   * Draw one frame, all at once.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} frame
   * @param {Path2D} frame.path coastline path, in the LOD's reference pixels
   * @param {number} frame.refWorldSize px per mercator unit the path was built at
   * @param {Affine} frame.matrix normalised mercator -> CSS px
   * @param {number} frame.width  canvas CSS width
   * @param {number} frame.height canvas CSS height
   * @param {number} [frame.pixelRatio=1]
   * @param {boolean} [frame.clear=true]
   * @returns {{ms:number, passes:number}}
   */
  draw(ctx, frame) {
    const t0 = now();
    const job = this.createJob(ctx, frame);
    while (!job.done) job.step();
    this.lastDrawMs = now() - t0;
    return { ms: this.lastDrawMs, passes: job.passes };
  }
}

/**
 * One frame's worth of drawing, executable a step at a time.
 *
 * Steps run in a fixed order and must not be reordered: each pass strokes a
 * band that the *next*, narrower pass partly erases, so working outward-in is
 * what produces separated waterlines rather than one solid halo. A half-run
 * job is therefore not a valid picture, which is exactly why the engine draws
 * it off-screen.
 */
class WaterlineDrawJob {
  /**
   * @param {WaterlineRenderer} renderer
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} frame
   */
  constructor(renderer, ctx, frame) {
    this.renderer = renderer;
    this.ctx = ctx;
    this.frame = frame;

    const style = renderer.style;
    this.style = style;
    this.passes = Math.max(1, Math.round(style.count)) + 1;

    const n = this.passes - 1;
    // Pen width, outermost pass first. Distances double into widths because a
    // stroke straddles the path it follows.
    this._pen = powScale([0, n], [2 * style.extent, 2 * style.inset], style.spacingExponent);
    this._nib = powScale([0, n], [2 * style.lineWidth[1], 2 * style.lineWidth[0]], 3);
    this._alpha = powScale([0, n], style.opacity, style.opacityExponent);
    this._n = n;

    // Animation. `null` means "hold still"; every expression below then
    // collapses to the static case, so a non-animated draw is unchanged.
    this._phase = style.phase;
    this._animated = this._phase !== null && this._phase !== undefined;

    // Line widths arrive in CSS pixels but are consumed in path units, which
    // the transform then scales. This is the conversion factor.
    this._unit = frame.refWorldSize / matrixScale(frame.matrix);

    // -1 = clear and set up; 0..n = passes; n + 1 = land mask and coastline.
    this.index = -1;
    this.done = false;
  }

  /** Fraction complete, 0..1. */
  get progress() {
    return (this.index + 1) / (this.passes + 1);
  }

  /** Execute the next step. */
  step() {
    if (this.done) return;
    const i = ++this.index;

    if (i === 0) {
      this._setup();
      if (!this.frame.path) this.done = true;
      return;
    }
    if (i <= this.passes) {
      this._applyTransform();
      this._pass(i - 1);
      return;
    }
    this._applyTransform();
    this._finish();
    this.done = true;
  }

  // ------------------------------------------------------------------------

  _setup() {
    const { width, height, pixelRatio = 1, clear = true } = this.frame;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (clear) ctx.clearRect(0, 0, width * pixelRatio, height * pixelRatio);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // `bevel` by default: the coastline path is already smooth, so bevel and
    // round joins are indistinguishable, and round joins on a path with tens
    // of thousands of short segments generate a lot of extra geometry.
    ctx.lineJoin = this.style.lineJoin || 'bevel';
    ctx.lineCap = 'round';
  }

  /**
   * Path coordinates live in "world pixels at the LOD zoom". Folding the
   * mercator->screen affine and the device pixel ratio into the canvas
   * transform is what keeps JavaScript from touching a single vertex per
   * frame.
   */
  _applyTransform() {
    const { matrix, refWorldSize, pixelRatio = 1 } = this.frame;
    const s = pixelRatio / refWorldSize;
    this.ctx.setTransform(
      matrix.a * s,
      matrix.b * s,
      matrix.c * s,
      matrix.d * s,
      matrix.e * pixelRatio,
      matrix.f * pixelRatio
    );
  }

  /**
   * Pen width of pass `i`, before the conversion to path units.
   *
   * Still: the pen scale, straight. Animated: Vane's interpolation from the
   * animation notebook - over one cycle every line travels outwards into the
   * slot the line ahead of it occupied, so line `i` runs from where line
   * `i + 1` sat to where line `i` sat. The innermost line has nowhere to come
   * from, so it is *born* at the shore and grows out of nothing.
   *
   * At phase 1 that is the still picture shifted by one line, which is why the
   * loop closes without a jump.
   */
  _band(i) {
    if (!this._animated) return this._pen(i);
    const n = this._n;
    if (i >= n) return this._pen(n) * this._phase; // the newborn
    const from = this._pen(i + 1);
    return from + (this._pen(i) - from) * this._phase;
  }

  /**
   * Fractional position of pass `i` in the per-line ramps (colour, opacity,
   * line weight), so those travel with the line instead of staying pinned to
   * a slot the line has left. Vane's line weight is a constant 2 px and her
   * colour is flat, so this has no counterpart in the notebook.
   */
  _slot(i) {
    if (!this._animated) return i;
    const u = i + 1 - this._phase;
    return u > this._n ? this._n : u;
  }

  /**
   * Cross-fade at the seam of the loop: the outermost line dies as it leaves
   * the picture, the innermost fades in as it is born. Without it the cycle
   * pops once per period.
   */
  _seam(i) {
    if (!this._animated) return 1;
    if (i === 0) return 1 - this._phase;
    if (i === this._n) return this._phase;
    return 1;
  }

  _pass(i) {
    const ctx = this.ctx;
    const style = this.style;
    const path = this.frame.path;
    const base = style.composite || 'source-over';
    const band = this._band(i);
    const slot = this._slot(i);

    ctx.globalCompositeOperation = base;
    ctx.strokeStyle = this.renderer._colorAt(1 - slot / this._n);
    ctx.globalAlpha = this._alpha(slot) * this._seam(i);
    ctx.lineWidth = (band + this._nib(slot)) * this._unit;
    ctx.stroke(path);

    if (!style.filled) {
      // Hollow out the pen stroke so only its rim survives. This is what turns
      // "a very fat line" into "a waterline".
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = band * this._unit;
      ctx.stroke(path);
      ctx.globalCompositeOperation = base;
    }
  }

  _finish() {
    const ctx = this.ctx;
    const style = this.style;
    const path = this.frame.path;

    // Every pass also painted the inward half of its stroke, which sits under
    // the land. Deal with all of it once, here.
    ctx.globalAlpha = 1;
    if (style.land === 'clip') {
      // Punch the land out so the map underneath shows through untouched.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fill(path, 'evenodd');
    } else if (style.land === 'fill') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = style.landColor;
      ctx.fill(path, 'evenodd');
    }
    ctx.globalCompositeOperation = 'source-over';

    if (style.coastline) {
      ctx.strokeStyle = style.coastline.color;
      ctx.globalAlpha = style.coastline.opacity ?? 1;
      ctx.lineWidth = (style.coastline.width ?? 0.8) * this._unit;
      ctx.stroke(path);
      ctx.globalAlpha = 1;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
