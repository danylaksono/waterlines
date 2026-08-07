/**
 * WaterlineEngine.js
 *
 * Map-agnostic engine: owns the overlay canvas, the LOD pyramid, the cull
 * cache, the renderer, and the adaptive-quality policy. It knows nothing about
 * MapLibre or deck.gl - hand it an affine transform and a size and it draws a
 * frame.
 *
 * Refresh policy lives here, and it is worth stating plainly:
 *
 *  - A frame never draws waterlines. It blits the bitmap the {@link RasterCache}
 *    is holding, transformed into place. Re-rendering that bitmap is a
 *    background job spread over frames.
 *  - That background job yields completely while the user is moving the map,
 *    unless the cached bitmap cannot cover the view. One pass over a
 *    continental coastline can cost more than a frame all by itself, and a
 *    pass is the smallest unit that leaves the bitmap valid - so there is no
 *    pacing that makes it fit. Not competing for the frame is the only answer.
 *  - Per-vertex work happens once per *zoom level*, never per frame, and a LOD
 *    build is never allowed to block a gesture: while `moving` is true the
 *    nearest cached level is used and the right one is built on an idle
 *    callback.
 *  - Under load, resolution degrades - not geometry and not the number of
 *    waterlines. The lines stay in exactly the same place and merely soften,
 *    which is far less distracting than lines that move or vanish.
 */

import { LodPyramid } from '../core/LodPyramid.js';
import { countVertices, geojsonToRings } from '../core/rings.js';
import { VisiblePathCache } from './VisiblePathCache.js';
import { WaterlineRenderer } from './WaterlineRenderer.js';
import { RasterCache } from './RasterCache.js';
import { WaterlineCycle } from './WaterlineCycle.js';
import { mercatorBounds } from './bounds.js';

/**
 * @typedef {Object} EngineOptions
 * @property {HTMLElement} container element the overlay canvas is appended to
 * @property {Object|import('../core/rings.js').Ring[]} [data] land polygons
 * @property {Partial<import('./style.js').WaterlineStyle> & {preset?:string}} [style]
 * @property {Object} [lod] forwarded to {@link LodPyramid}
 * @property {number} [pixelRatio] backing-store ratio at rest
 * @property {number} [interactivePixelRatio=1] ratio for a refresh that has to
 *   happen mid-gesture
 * @property {number} [draftPixelRatio=0.5] ratio for the first of the two
 *   at-rest passes; set it equal to `pixelRatio` to render once, sharply, and
 *   wait longer for anything to appear
 * @property {number} [draftLodOffset=2] how many zoom levels of geometry
 *   detail the draft gives up
 * @property {boolean} [adaptive=true] trim the interactive ratio when frames
 *   exceed `frameBudgetMs`
 * @property {number} [frameBudgetMs=20] target frame *interval*; a background
 *   refresh throttles itself to keep frames near this (see {@link RasterCache})
 * @property {number} [rasterPad=192] margin around the viewport kept in the
 *   cache, CSS px - bigger means fewer refreshes while panning
 * @property {Object} [cycle] forwarded to {@link WaterlineCycle}; only matters
 *   if the animation is switched on with {@link WaterlineEngine#setAnimation}
 * @property {number} [padding=64] cull padding beyond the ripple extent, px
 * @property {boolean} [visible=true]
 * @property {() => void} [onInvalidate] called when a background LOD build
 *   finished and the host should schedule another frame
 * @property {(stats:Object) => void} [onFrame]
 */

export class WaterlineEngine {
  /** @param {EngineOptions} options */
  constructor(options = {}) {
    if (!options.container) throw new Error('WaterlineEngine requires a container element');

    this.options = {
      pixelRatio: Math.min(
        typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
        2
      ),
      interactivePixelRatio: 1,
      // Animation frames are held `frames` times over, so their resolution is
      // the setting that decides whether a loop costs 60 MB or 240 MB. 1 is
      // the honest default; raise it for a small viewport or a short loop.
      animationPixelRatio: 1,
      draftPixelRatio: 0.5,
      draftLodOffset: 2,
      adaptive: true,
      frameBudgetMs: 20,
      rasterPad: 192,
      padding: 64,
      visible: true,
      ...options,
    };

    this.renderer = new WaterlineRenderer(this.options.style);
    this.pathCache = new VisiblePathCache();
    this.raster = new RasterCache({ pad: this.options.rasterPad });
    this.cycle = new WaterlineCycle(this.options.cycle);
    this.visible = this.options.visible !== false;

    /** @type {{periodMs:number, direction:number}|null} */
    this._animation = null;
    this._animationStart = 0;
    this._cycleFrame = -1;

    this.width = 0;
    this.height = 0;
    this._dirty = true;
    this._lodPending = false;
    this._idleHandle = null;
    this._frameMs = 0;
    this._lastFrameAt = 0;
    this._lastMoving = false;
    this._lastLevel = null;
    this._lastRings = 0;
    this._interactiveRatio = this.options.interactivePixelRatio;
    this._currentRatio = 0;
    this._lastRasterRatio = this.options.pixelRatio;
    this._stats = emptyStats();

    this._createCanvas(this.options.container);
    this.setData(this.options.data);
  }

  // ------------------------------------------------------------------------
  // data & style
  // ------------------------------------------------------------------------

  /**
   * @param {Object|import('../core/rings.js').Ring[]} data GeoJSON or rings
   */
  setData(data) {
    const rings = Array.isArray(data) ? data : data ? geojsonToRings(data) : [];
    this.rings = rings;
    this.sourceVertices = countVertices(rings);
    this.pyramid = new LodPyramid(rings, this.options.lod);
    this.pathCache.invalidate();
    this.invalidate();
    return this;
  }

  /**
   * Style changes never touch geometry, so this is cheap enough to drive from
   * a slider's `input` event.
   *
   * @param {Partial<import('./style.js').WaterlineStyle> & {preset?:string}} style
   */
  setStyle(style) {
    this.renderer.setStyle(style);
    this.invalidate();
    return this;
  }

  /**
   * Simplification / curve settings. Unlike {@link setStyle} this discards
   * every cached level, so use it sparingly.
   *
   * @param {Object} lod
   */
  setLodOptions(lod) {
    this.options.lod = { ...this.options.lod, ...lod };
    this.pyramid = new LodPyramid(this.rings, this.options.lod);
    this.pathCache.invalidate();
    this.invalidate();
    return this;
  }

  /**
   * Switch the waterline animation on or off.
   *
   * Off by default, and worth understanding before switching it on. A still
   * overlay renders one bitmap and reuses it for as long as the view holds;
   * an animated one renders a whole loop of them (see {@link WaterlineCycle}),
   * so settling on a new view costs `frames` times as much work and holds
   * `frames` times as many pixels in memory. In exchange, playback itself is
   * free: once the loop exists, a tick is one `drawImage`.
   *
   * While the view is moving, or while a loop is being built, the still bitmap
   * is shown instead - the animation pauses and picks up again once the map
   * settles. That is deliberate: competing with a gesture for the frame is
   * what the whole engine is built to avoid.
   *
   * @param {Object|null} animation `null`, or `false`, turns it off
   * @param {number} [animation.periodMs=1350] time for one full loop
   * @param {'outwards'|'inwards'} [animation.direction='outwards'] which way
   *   the waterlines travel. Vane makes the case that inwards - waves washing
   *   ashore - is the truer analogy, and that outwards nonetheless tends to
   *   look right; it is genuinely a matter of taste.
   * @param {number} [animation.frames] pictures per loop, default 12
   */
  setAnimation(animation) {
    if (!animation) {
      this._animation = null;
      this.cycle.invalidate();
      this.renderer.setStyle({ phase: null });
      this.invalidate();
      return this;
    }

    const { periodMs = 1350, direction = 'outwards', frames } = animation;
    if (frames) this.cycle.frames = Math.max(2, Math.round(frames));
    this._animation = {
      periodMs: Math.max(1, periodMs),
      direction: direction === 'inwards' ? -1 : 1,
    };
    if (!this._animationStart) this._animationStart = now();
    this.cycle.invalidate();
    this.invalidate();
    return this;
  }

  /** @returns {boolean} */
  get isAnimating() {
    return !!this._animation;
  }

  /** @param {boolean} value */
  setVisible(value) {
    this.visible = !!value;
    this.canvas.style.display = this.visible ? '' : 'none';
    this.invalidate();
    return this;
  }

  /**
   * Resolution a refresh started mid-gesture renders at. Lower is faster and
   * softer; line *positions* are unaffected, which is why this is the knob
   * that gives way under load rather than the line count or the geometry.
   *
   * @param {number} ratio
   * @param {boolean} [sticky=true] also raise the ceiling, so the adaptive
   *   controller may climb back to this value
   */
  setInteractivePixelRatio(ratio, sticky = true) {
    this._interactiveRatio = ratio;
    if (sticky) this.options.interactivePixelRatio = ratio;
    this.invalidate();
    return this;
  }

  /** @param {boolean} value let the engine tune the interactive resolution */
  setAdaptive(value) {
    this.options.adaptive = !!value;
    return this;
  }

  /**
   * Mark the next frame as needing a redraw even if the view has not moved.
   *
   * Any animation loop goes with it: everything that invalidates the still
   * bitmap - style, data, geometry detail - changes every frame of the loop
   * too.
   */
  invalidate() {
    this._dirty = true;
    this.cycle.invalidate();
    return this;
  }

  /** @returns {boolean} true when the next `render` would actually draw */
  get isDirty() {
    return this._dirty;
  }

  /**
   * True while the engine still has work it wants frames for: something was
   * invalidated, a refresh is in flight, or the bitmap on screen is a draft
   * waiting to be refined.
   *
   * Hosts must keep scheduling frames while this holds. Both MapLibre and
   * deck.gl stop drawing once their own view settles, and a background refresh
   * only advances on the frames it is given.
   *
   * @returns {boolean}
   */
  get isBusy() {
    // An animation never finishes, so while one is running the host must keep
    // scheduling frames unconditionally.
    if (this._animation) return true;
    return this._dirty || this.raster.hasJob || this.raster.isCoarse;
  }

  /** Latest frame diagnostics. */
  getStats() {
    return { ...this._stats, sourceVertices: this.sourceVertices };
  }

  /**
   * A readable copy of the current picture, for compositing into an export.
   *
   * A 2D canvas is readable whenever you like, so this is the canvas itself.
   * It exists to match `WaterlineGLEngine#snapshot`, where getting readable
   * pixels back out is genuinely work - so an export can ask both renderers
   * the same question.
   *
   * @returns {HTMLCanvasElement|null}
   */
  snapshot() {
    return this.visible ? this.canvas : null;
  }

  // ------------------------------------------------------------------------
  // frame
  // ------------------------------------------------------------------------

  /**
   * @param {number} width  CSS px
   * @param {number} height CSS px
   */
  resize(width, height) {
    if (width === this.width && height === this.height) return this;
    this.width = width;
    this.height = height;
    // Size the element explicitly rather than with `100%`: the overlay is
    // parented to whatever container the host gives us, and some of those
    // (MapLibre's canvas container, for one) do not have a resolved height.
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this._currentRatio = 0; // force the backing store to be recreated
    this._dirty = true;
    this.cycle.invalidate(); // every frame of the loop is the wrong size now
    return this;
  }

  /**
   * Draw one frame.
   *
   * @param {import('./WaterlineRenderer.js').Affine} matrix
   *   normalised mercator -> CSS px
   * @param {Object} [frame]
   * @param {boolean} [frame.moving=false] is the user mid-gesture?
   * @returns {Object|null} stats, or null when nothing was drawn
   */
  render(matrix, frame = {}) {
    if (!this.visible || !this.ctx || !this.width || !this.height) return null;

    const moving = !!frame.moving;
    this._lastMoving = moving;
    const t0 = now();
    const raster = this.raster;

    // How long the previous frame actually took, end to end. This is the only
    // honest cost signal available (see `RasterCache#advance`), and it is what
    // paces the background refresh.
    const gap = this._lastFrameAt ? Math.min(t0 - this._lastFrameAt, 500) : 0;
    // One budget, moving or not. Raising it at rest looks tempting - nothing
    // is competing for the frame - but it backfires: the controller cannot see
    // rasterisation cost, so a larger budget just makes it submit the whole
    // refresh in one frame, and the page locks up for as long as that takes.
    const target = this.options.frameBudgetMs;

    this._applyPixelRatio(this.options.pixelRatio);

    // A single pass over a continental coastline can cost far more than a
    // frame - more than any pacing can hide, because one pass is the smallest
    // unit that leaves the bitmap in a valid state. So while the user is
    // actually moving the map, a refresh yields entirely, and the cached
    // bitmap is blitted instead. It resumes the moment the gesture ends.
    //
    // The exception is a view the cache cannot cover at all: then there is
    // nothing to blit and rendering something coarse beats rendering nothing.
    const covered = raster.covers(matrix, this.width, this.height);
    const mayRefresh = !moving || !covered;

    // 1. Keep any in-flight refresh moving.
    let mode = raster.hasJob ? (mayRefresh ? 'refreshing' : 'deferred') : 'blit';
    if (raster.hasJob && mayRefresh) raster.advance(gap, target);

    // 2. Decide whether a new refresh is needed. Note the asymmetry: while the
    //    user is moving we only refresh when the bitmap no longer covers the
    //    view, but once the view settles we also refresh to shed a coarse or
    //    rescaled bitmap and get an exact one.
    if (mayRefresh && this._needsRefresh(matrix, moving)) {
      this._beginRefresh(matrix, moving);
      raster.advance(gap, target);
      mode = 'refreshing';
    }

    // 3. If the animation is on, keep its loop of bitmaps up to date. This
    //    only ever runs on a settled view with a sharp still bitmap already
    //    in hand, so it competes with nothing.
    const cycleFrame = this._animation ? this._advanceCycle(matrix, moving) : -1;

    // 4. Show the best bitmap available. During a refresh that is the previous
    //    one, transformed into place - stale, never half-drawn.
    if (cycleFrame >= 0) {
      this.cycle.blit(this.ctx, cycleFrame, matrix, this.width, this.height, this._currentRatio);
      this._cycleFrame = cycleFrame;
      mode = 'animating';
    } else {
      raster.blit(this.ctx, matrix, this.width, this.height, this._currentRatio);
      this._cycleFrame = -1;
      if (!raster.hasJob && mode === 'refreshing') mode = 'render';
      if (this.cycle.building) mode = 'cycling';
    }

    const elapsed = now() - t0;
    this._track(gap, moving, t0);

    this._stats = {
      submitMs: elapsed,
      frameMs: this._frameMs,
      mode,
      pending: raster.hasJob,
      // True while the bitmap on screen is the fast draft, before the
      // full-resolution pass replaces it.
      draft: raster.isCoarse,
      commits: raster.commits,
      progress: raster.progress,
      stepsPerFrame: raster.stepsPerFrame,
      rings: this._lastRings,
      vertices: this._lastLevel ? this._lastLevel.vertices : 0,
      sourceVertices: this.sourceVertices,
      lodZoom: this._lastLevel ? this._lastLevel.zoom : null,
      pixelRatio: this._currentRatio,
      rasterRatio: this._lastRasterRatio,
      moving,
      animating: !!this._animation,
      cycleFrame: this._cycleFrame,
      cycleFrames: this.cycle.entries.length,
      cycleProgress: this._animation ? this.cycle.progress : 1,
    };
    if (this.options.onFrame) this.options.onFrame(this._stats);
    return this._stats;
  }

  /**
   * True when the overlay should start rendering a new bitmap.
   *
   * @param {import('./WaterlineRenderer.js').Affine} matrix
   * @param {boolean} moving
   */
  _needsRefresh(matrix, moving) {
    const raster = this.raster;
    if (this._dirty) return true;

    // A refresh already under way and still valid for this view: let it run.
    if (raster.hasJob && raster.jobCovers(matrix, this.width, this.height)) {
      return false;
    }
    if (!raster.covers(matrix, this.width, this.height)) return true;
    // Settled on a bitmap that was rendered coarse, or under a gesture that
    // has since rescaled it: redo it properly.
    if (!moving && (raster.isCoarse || !this._exactFor(matrix))) return true;
    return false;
  }

  /** Was the visible bitmap rendered with exactly this transform's scale? */
  _exactFor(matrix) {
    const current = this.raster.current;
    if (!current) return false;
    const ratio = Math.abs(
      Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) /
        Math.sqrt(
          Math.abs(
            current.matrix.a * current.matrix.d - current.matrix.b * current.matrix.c
          )
        ) -
        1
    );
    return ratio < 1e-6;
  }

  /**
   * Resolution for a refresh that is about to start.
   *
   * At rest this is a two-rung ladder: render coarse first, then again at full
   * resolution. A full render of a continental view is a second or two of
   * work, and staring at a bare map for that long is worse than seeing soft
   * waterlines four times sooner. The second rung is not scheduled here - the
   * coarse bitmap is flagged `coarse`, and `_needsRefresh` picks it up.
   *
   * @param {boolean} moving
   * @returns {number}
   */
  _refreshRatio(moving) {
    const full = this.options.pixelRatio;
    if (moving) return Math.min(this._interactiveRatio, full);
    // Already showing a draft: this is the refining pass.
    if (this.raster.isCoarse) return full;
    return Math.min(this.options.draftPixelRatio, full);
  }

  /**
   * Cull, assemble the path, and hand the renderer a step-wise job.
   *
   * @param {import('./WaterlineRenderer.js').Affine} matrix
   * @param {boolean} moving
   */
  _beginRefresh(matrix, moving) {
    const pixelRatio = this._refreshRatio(moving);
    const draft = pixelRatio < this.options.pixelRatio;
    this._lastRasterRatio = pixelRatio;
    this._dirty = false;

    this.raster.begin({
      matrix,
      width: this.width,
      height: this.height,
      pixelRatio,
      coarse: draft,
      createJob: (ctx, frame) => {
        const zoom = this.zoomFromMatrix(frame.matrix);
        // A draft drops geometry detail as well as resolution, and that is the
        // half that matters: stroking a path costs roughly what its vertex
        // count costs, largely independent of how many pixels it covers, so
        // halving the resolution alone barely helps.
        const level = this._level(
          draft ? zoom - this.options.draftLodOffset : zoom,
          moving
        );
        const pad = this.renderer.style.extent + this.options.padding;
        const bounds = mercatorBounds(frame.matrix, frame.width, frame.height, pad);
        const { path, refWorldSize, ringCount } = this.pathCache.update(level, bounds);

        this._lastLevel = level;
        this._lastRings = ringCount;

        return this.renderer.createJob(ctx, { ...frame, path, refWorldSize });
      },
    });
  }

  /**
   * Keep the animation loop current, and say which of its frames belongs on
   * screen right now.
   *
   * @param {import('./WaterlineRenderer.js').Affine} matrix
   * @param {boolean} moving
   * @returns {number} frame index, or -1 to fall back to the still bitmap
   */
  _advanceCycle(matrix, moving) {
    const cycle = this.cycle;

    // Building a loop is `frames` full renders. It waits for a view that has
    // settled *and* already has a sharp still bitmap - so the map is never
    // waiting on it, and the user is never staring at nothing while it runs.
    const mayBuild =
      !moving && !this.raster.hasJob && !this.raster.isCoarse && this._exactFor(matrix);

    if (cycle.building && !cycle.jobCovers(matrix, this.width, this.height)) {
      cycle.invalidate(); // the view moved out from under it
    }
    if (mayBuild && !cycle.building && !cycle.covers(matrix, this.width, this.height)) {
      this._beginCycle(matrix);
    }
    if (mayBuild && cycle.building) {
      // Paced by the same controller as a still refresh: the work is the same
      // work, and the frame-interval signal it steers on is already tuned.
      cycle.advance(this.raster.stepsPerFrame);
    }

    if (!cycle.covers(matrix, this.width, this.height)) return -1;
    return cycle.frameAt(
      now() - this._animationStart,
      this._animation.periodMs,
      this._animation.direction
    );
  }

  /**
   * Start rendering a loop for this view: the same cull, path and job the
   * still bitmap uses, once per phase.
   *
   * @param {import('./WaterlineRenderer.js').Affine} matrix
   */
  _beginCycle(matrix) {
    const pixelRatio = Math.min(this.options.animationPixelRatio, this.options.pixelRatio);

    this.cycle.begin({
      matrix,
      width: this.width,
      height: this.height,
      pixelRatio,
      createJob: (ctx, frame, phase) => {
        const zoom = this.zoomFromMatrix(frame.matrix);
        const level = this._level(zoom, false);
        const pad = this.renderer.style.extent + this.options.padding;
        const bounds = mercatorBounds(frame.matrix, frame.width, frame.height, pad);
        const { path, refWorldSize } = this.pathCache.update(level, bounds);

        // A job snapshots its scales at construction, so the phase only has to
        // be set for the length of this call - and putting it back afterwards
        // is what keeps a later still refresh still.
        this.renderer.setStyle({ phase });
        const job = this.renderer.createJob(ctx, { ...frame, path, refWorldSize });
        this.renderer.setStyle({ phase: null });
        return job;
      },
    });
  }

  /**
   * Zoom implied by an affine transform: its uniform scale is the world size
   * in pixels, and world size is `512 * 2 ** zoom`.
   *
   * @param {import('./WaterlineRenderer.js').Affine} m
   * @returns {number}
   */
  zoomFromMatrix(m) {
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    return Math.log2(scale / 512);
  }

  /** Detach and free. */
  destroy() {
    if (this._idleHandle !== null) cancelIdle(this._idleHandle);
    if (this.canvas) this.canvas.remove();
    this.raster.invalidate();
    this.cycle.invalidate();
    this._animation = null;
    this.canvas = null;
    this.ctx = null;
    this.pyramid = null;
  }

  // ------------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------------

  _createCanvas(container) {
    const canvas = document.createElement('canvas');
    canvas.className = 'waterlines-canvas';
    Object.assign(canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      pointerEvents: 'none',
    });
    if (!this.visible) canvas.style.display = 'none';
    container.appendChild(canvas);

    this.canvas = canvas;
    // `alpha` because the map has to show through; `desynchronized` lets the
    // compositor skip a copy on browsers that support it.
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!this.ctx) {
      throw new Error('Could not acquire a 2D context for the waterlines overlay');
    }
  }

  _applyPixelRatio(ratio) {
    if (ratio === this._currentRatio) return;
    this._currentRatio = ratio;
    this.canvas.width = Math.max(1, Math.round(this.width * ratio));
    this.canvas.height = Math.max(1, Math.round(this.height * ratio));
  }

  /**
   * Pick a level of detail. Building one costs milliseconds, so it never
   * happens mid-gesture: the nearest cached level is used and the right one is
   * queued for the next idle slot.
   */
  _level(zoom, moving) {
    if (!this.pyramid.isStale(zoom)) return this.pyramid.get(zoom);
    if (!moving) return this.pyramid.get(zoom);

    const nearest = this.pyramid.peek(zoom);
    if (!nearest) return this.pyramid.get(zoom); // cold start: block exactly once
    this._scheduleLodBuild(zoom);
    return nearest;
  }

  _scheduleLodBuild(zoom) {
    if (this._lodPending) return;
    this._lodPending = true;
    this._idleHandle = requestIdle(() => {
      this._lodPending = false;
      this._idleHandle = null;
      if (!this.ctx) return;
      this.pyramid.get(zoom);
      this.invalidate();
      if (this.options.onInvalidate) this.options.onInvalidate();
    });
  }

  /**
   * Keep a moving average of the frame interval, and adapt the resolution a
   * mid-gesture refresh renders at.
   *
   * Re-tuning only happens at rest, because changing the ratio reallocates
   * backing stores - not something to do mid-drag.
   *
   * @param {number} gap interval since the previous frame, ms
   * @param {boolean} moving
   * @param {number} at timestamp of this frame
   */
  _track(gap, moving, at) {
    if (gap > 0) {
      this._frameMs = this._frameMs ? this._frameMs * 0.8 + gap * 0.2 : gap;
    }
    this._lastFrameAt = at;

    if (!this.options.adaptive || moving || !this._frameMs) return;

    const budget = this.options.frameBudgetMs;
    const ceiling = this.options.interactivePixelRatio;
    if (this._frameMs > budget * 1.5 && this._interactiveRatio > 0.5) {
      this._interactiveRatio = Math.max(0.5, quarter(this._interactiveRatio - 0.25));
    } else if (this._frameMs < budget && this._interactiveRatio < ceiling) {
      this._interactiveRatio = Math.min(ceiling, quarter(this._interactiveRatio + 0.25));
    }
  }
}

function emptyStats() {
  return {
    submitMs: 0,
    frameMs: 0,
    mode: 'blit',
    pending: false,
    draft: false,
    commits: 0,
    progress: 1,
    stepsPerFrame: 1,
    rings: 0,
    vertices: 0,
    sourceVertices: 0,
    lodZoom: null,
    pixelRatio: 0,
    rasterRatio: 0,
    moving: false,
    animating: false,
    cycleFrame: -1,
    cycleFrames: 0,
    cycleProgress: 1,
  };
}

function quarter(v) {
  return Math.round(v * 4) / 4;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function requestIdle(fn) {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(fn, { timeout: 250 });
  }
  return setTimeout(fn, 0);
}

function cancelIdle(handle) {
  if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle);
  else clearTimeout(handle);
}
