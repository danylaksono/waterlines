/**
 * WaterlineGLEngine.js
 *
 * The GL path's engine. It presents the same surface as
 * `render/WaterlineEngine.js` - `resize`, `render(matrix, {moving})`,
 * `setStyle`, `setData`, `setAnimation`, `getStats`, `destroy` - so an adapter
 * can hold either one and not care which.
 *
 * What is striking is how much of the 2D engine is simply *absent* here, and
 * why. Every one of these exists to hide the cost of re-rasterising N
 * waterlines:
 *
 *   RasterCache        a bitmap to blit while a new one renders
 *   VisiblePathCache   the per-frame cull and combined-path assembly
 *   step scheduling    a refresh spread over frames to avoid dropping any
 *   draft ladder       render coarse first, refine at rest
 *   adaptive ratio     trade resolution when frames run long
 *   WaterlineCycle     precomputed animation frames
 *
 * None are needed when a frame costs a handful of fullscreen passes regardless
 * of the waterline count. What remains is the LOD pyramid - which is about
 * *geometry*, not rasterisation, and is still worth having, because uploading
 * a simplified mesh once per zoom beats uploading the full one every time.
 */

import { LodPyramid } from '../core/LodPyramid.js';
import { countVertices, geojsonToRings } from '../core/rings.js';
import { RingVertexSink, buildLevelMesh } from './geometry.js';
import { GLUnavailableError, WaterlineGLRenderer } from './WaterlineGLRenderer.js';

export { GLUnavailableError };

export class WaterlineGLEngine {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.container
   * @param {Object|import('../core/rings.js').Ring[]} [options.data]
   * @param {Partial<import('../render/style.js').WaterlineStyle> & {preset?:string}} [options.style]
   * @param {Object} [options.lod] forwarded to {@link LodPyramid}
   * @param {number} [options.pixelRatio]
   * @param {boolean} [options.visible=true]
   * @param {() => void} [options.onInvalidate]
   * @param {(stats:Object) => void} [options.onFrame]
   * @throws {GLUnavailableError} when WebGL2 with float targets is unavailable
   */
  constructor(options = {}) {
    if (!options.container) throw new Error('WaterlineGLEngine requires a container element');

    this.options = {
      pixelRatio: Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2),
      visible: true,
      ...options,
    };

    this._createCanvas(this.options.container);
    this.renderer = new WaterlineGLRenderer(this.canvas, this.options.style);
    this.visible = this.options.visible !== false;

    this.width = 0;
    this.height = 0;
    this._dirty = true;
    this._lastLevel = null;
    this._meshes = new Map();
    this._animation = null;
    this._animationStart = 0;
    this._stats = emptyStats();

    this.setData(this.options.data);
  }

  // ------------------------------------------------------------------------
  // data & style
  // ------------------------------------------------------------------------

  /** @param {Object|import('../core/rings.js').Ring[]} data */
  setData(data) {
    const rings = Array.isArray(data) ? data : data ? geojsonToRings(data) : [];
    this.rings = rings;
    this.sourceVertices = countVertices(rings);
    this.pyramid = new LodPyramid(rings, {
      ...this.options.lod,
      // The pyramid builds whatever `createPath` returns. Handing it a vertex
      // sink instead of a Path2D means the GL mesh comes out of the identical
      // simplify + Catmull-Rom + flatten pipeline the 2D path uses, so the two
      // renderers are drawing the same coastline down to the vertex.
      createPath: () => new RingVertexSink(),
    });
    this._meshes.clear();
    this.invalidate();
    return this;
  }

  /** @param {Partial<import('../render/style.js').WaterlineStyle> & {preset?:string}} style */
  setStyle(style) {
    this.renderer.setStyle(style);
    this.invalidate();
    return this;
  }

  /** @param {Object} lod */
  setLodOptions(lod) {
    this.options.lod = { ...this.options.lod, ...lod };
    this.setData(this.rings);
    return this;
  }

  /** @param {boolean} value */
  setVisible(value) {
    this.visible = !!value;
    this.canvas.style.display = this.visible ? '' : 'none';
    this.invalidate();
    return this;
  }

  /**
   * Animate the waterlines.
   *
   * Unlike the 2D path this costs **nothing** - the phase is one uniform, and
   * a frame is the same handful of passes whether it is moving or still. There
   * are no precomputed frames to build, so nothing to wait for, no memory
   * held, and the animation keeps running *during* a pan or zoom.
   *
   * @param {Object|null} animation
   * @param {number} [animation.periodMs=1350]
   * @param {'outwards'|'inwards'} [animation.direction='outwards']
   */
  setAnimation(animation) {
    if (!animation) {
      this._animation = null;
      this.renderer.setStyle({ phase: null });
      this.invalidate();
      return this;
    }
    const { periodMs = 1350, direction = 'outwards' } = animation;
    this._animation = {
      periodMs: Math.max(1, periodMs),
      direction: direction === 'inwards' ? -1 : 1,
    };
    if (!this._animationStart) this._animationStart = now();
    this.invalidate();
    return this;
  }

  /** @returns {boolean} */
  get isAnimating() {
    return !!this._animation;
  }

  /**
   * Present for parity with the 2D engine, where resolution is the thing that
   * gives way under load. Nothing gives way here, so this is a no-op that
   * records the request rather than a silent lie.
   *
   * @param {number} ratio
   */
  setInteractivePixelRatio(ratio) {
    this._requestedInteractiveRatio = ratio;
    return this;
  }

  /** @param {boolean} value no-op; see {@link setInteractivePixelRatio} */
  setAdaptive(value) {
    this._requestedAdaptive = !!value;
    return this;
  }

  /** Mark the next frame as needing a redraw. */
  invalidate() {
    this._dirty = true;
    return this;
  }

  /** @returns {boolean} */
  get isDirty() {
    return this._dirty;
  }

  /** @returns {boolean} true while the host must keep scheduling frames */
  get isBusy() {
    return this._dirty || !!this._animation;
  }

  /** Latest frame diagnostics. */
  getStats() {
    return { ...this._stats, sourceVertices: this.sourceVertices };
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
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this._dirty = true;
    return this;
  }

  /**
   * Draw one frame.
   *
   * Note what is missing: no `moving` branch. There is nothing to defer,
   * because a frame does not cost enough to be worth deferring - the whole
   * mid-gesture yield policy of the 2D engine has no reason to exist here.
   *
   * @param {import('../render/WaterlineRenderer.js').Affine} matrix
   * @param {Object} [frame]
   * @param {boolean} [frame.moving=false] recorded for diagnostics only
   * @returns {Object|null}
   */
  render(matrix, frame = {}) {
    if (!this.visible || !this.width || !this.height) return null;
    const t0 = now();

    if (this._animation) {
      const turns =
        ((t0 - this._animationStart) / this._animation.periodMs) * this._animation.direction;
      this.renderer.setPhase(turns);
    }

    const zoom = this.zoomFromMatrix(matrix);
    const level = this._level(zoom, !!frame.moving);
    const mesh = this._meshFor(level);
    this.renderer.setMesh(mesh, level.zoom);

    const result = this.renderer.draw({
      matrix,
      refWorldSize: level.refWorldSize,
      width: this.width,
      height: this.height,
      pixelRatio: this.options.pixelRatio,
    });

    this._lastLevel = level;
    this._lastMatrix = matrix;
    this._dirty = false;

    this._stats = {
      submitMs: result.ms,
      frameMs: now() - t0,
      mode: this._animation ? 'gl-animating' : 'gl',
      renderer: 'gl',
      floodPasses: result.passes,
      rings: level.rings.length,
      vertices: level.vertices,
      sourceVertices: this.sourceVertices,
      lodZoom: level.zoom,
      pixelRatio: this.options.pixelRatio,
      animating: !!this._animation,
      moving: !!frame.moving,
    };
    if (this.options.onFrame) this.options.onFrame(this._stats);
    return this._stats;
  }

  /**
   * A readable copy of the current picture, for compositing into an export.
   *
   * This exists because a WebGL drawing buffer is not readable once the frame
   * has been composited - `drawImage` on the canvas afterwards yields
   * transparent pixels. The usual workaround, `preserveDrawingBuffer: true`,
   * makes the browser keep a copy of every frame forever to serve a readback
   * that happens once in a session; the cost lands on interaction, which is
   * the one thing this renderer exists to protect.
   *
   * So instead: render and read back inside a single task, while the buffer is
   * still live. The result is an ordinary 2D canvas that behaves like the 2D
   * renderer's, which is what lets the export path treat both the same.
   *
   * @returns {HTMLCanvasElement|null} null when there is nothing to show
   */
  snapshot() {
    if (!this.visible || !this.width || !this.height || !this._lastMatrix) return null;

    this.render(this._lastMatrix, { moving: false });

    const gl = this.renderer.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const image = out.getContext('2d').createImageData(w, h);
    const data = image.data;

    for (let y = 0; y < h; y++) {
      // readPixels counts rows from the bottom, ImageData from the top.
      const src = (h - 1 - y) * w * 4;
      const dst = y * w * 4;
      for (let x = 0; x < w * 4; x += 4) {
        const a = pixels[src + x + 3];
        if (a === 0) continue;
        // The drawing buffer is premultiplied; ImageData is not.
        const k = 255 / a;
        data[dst + x] = Math.min(255, pixels[src + x] * k);
        data[dst + x + 1] = Math.min(255, pixels[src + x + 1] * k);
        data[dst + x + 2] = Math.min(255, pixels[src + x + 2] * k);
        data[dst + x + 3] = a;
      }
    }
    out.getContext('2d').putImageData(image, 0, 0);
    return out;
  }

  /**
   * Zoom implied by an affine transform.
   *
   * @param {import('../render/WaterlineRenderer.js').Affine} m
   * @returns {number}
   */
  zoomFromMatrix(m) {
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    return Math.log2(scale / 512);
  }

  /** Detach and free. */
  destroy() {
    this.renderer.destroy();
    if (this.canvas) this.canvas.remove();
    this.canvas = null;
    this.pyramid = null;
    this._meshes.clear();
    this._animation = null;
  }

  // ------------------------------------------------------------------------

  _createCanvas(container) {
    const canvas = document.createElement('canvas');
    canvas.className = 'waterlines-canvas waterlines-canvas-gl';
    Object.assign(canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      pointerEvents: 'none',
    });
    if (this.options.visible === false) canvas.style.display = 'none';
    container.appendChild(canvas);
    this.canvas = canvas;
  }

  /**
   * Pick a level of detail.
   *
   * Building one is simplification, curve generation and flattening - CPU
   * work, and the same CPU work as on the 2D path. So it keeps the same rule:
   * never build during a gesture, use the nearest cached level and queue the
   * right one for the next idle slot. This is the only part of the 2D engine's
   * scheduling that survives, because it is the only part that was ever about
   * geometry rather than rasterisation.
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
    requestIdle(() => {
      this._lodPending = false;
      if (!this.canvas) return;
      this.pyramid.get(zoom);
      this.invalidate();
      if (this.options.onInvalidate) this.options.onInvalidate();
    });
  }

  /**
   * Mesh for a level, built once and kept for as long as the level is.
   *
   * The whole level goes to the GPU, not just the visible rings: a few hundred
   * thousand line segments is a trivial mesh, off-screen geometry costs
   * nothing once clipped, and not culling removes the per-frame CPU work
   * entirely.
   */
  _meshFor(level) {
    let mesh = this._meshes.get(level.zoom);
    if (mesh) return mesh;
    mesh = buildLevelMesh(level.rings);
    this._meshes.set(level.zoom, mesh);
    // The pyramid keeps four levels; keeping meshes for more than that would
    // hold vertex arrays for geometry that can no longer be drawn.
    if (this._meshes.size > 4) {
      this._meshes.delete(this._meshes.keys().next().value);
    }
    return mesh;
  }
}

function emptyStats() {
  return {
    submitMs: 0,
    frameMs: 0,
    mode: 'gl',
    renderer: 'gl',
    floodPasses: 0,
    rings: 0,
    vertices: 0,
    sourceVertices: 0,
    lodZoom: null,
    pixelRatio: 0,
    animating: false,
    moving: false,
  };
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
