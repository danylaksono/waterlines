/**
 * LodPyramid.js
 *
 * Level-of-detail cache for coastline rings.
 *
 * This is the single most important piece for keeping the map interactive.
 * The expensive work - simplification, curve smoothing, `Path2D` construction
 * - depends only on the *zoom level*, never on the pan position. So we do it
 * once per integer zoom, cache it, and per frame do nothing but pick a level,
 * cull by bbox and stroke.
 *
 * Each level stores its geometry in "world pixels at that level's zoom", so
 * path coordinates stay in a well-conditioned numeric range and the per-frame
 * canvas transform is a small scale factor (0.5x .. 2x) rather than a scale of
 * a million.
 */

import { simplifyRings } from './simplify.js';
import { appendRingToPath } from './path.js';
import { worldSize } from './mercator.js';

/**
 * @typedef {Object} LodLevel
 * @property {number} zoom integer zoom this level was built for
 * @property {number} refWorldSize world size in px at `zoom`
 * @property {Array<Object>} rings simplified rings, each with a `path` (Path2D)
 * @property {number} vertices total vertex count after simplification
 * @property {number} buildMs
 */

export class LodPyramid {
  /**
   * @param {import('./rings.js').Ring[]} rings source rings, normalised mercator
   * @param {Object} [options]
   * @param {number} [options.tolerancePx=0.6] simplification tolerance, in
   *   screen pixels at the level's zoom
   * @param {number} [options.minRingPx=1.5] drop rings smaller than this on
   *   screen; Indonesia has thousands of sub-pixel islets at low zoom
   * @param {number} [options.minZoom=0]
   * @param {number} [options.maxZoom=18]
   * @param {'catmullRom'|'linear'} [options.curve='catmullRom']
   * @param {number} [options.alpha=0.5]
   * @param {number} [options.maxCached=4] LRU size; each level holds a Path2D
   *   per ring, so this bounds memory
   * @param {() => Object} [options.createPath] path factory, injectable for tests
   */
  constructor(rings, options = {}) {
    this.rings = rings;
    this.options = {
      tolerancePx: 0.6,
      minRingPx: 1.5,
      minZoom: 0,
      maxZoom: 18,
      curve: 'catmullRom',
      alpha: 0.5,
      flatness: 0.75,
      maxCached: 4,
      createPath: () => new Path2D(),
      ...options,
    };
    /** @type {Map<number, LodLevel>} */
    this.levels = new Map();
  }

  /**
   * Integer level a given fractional zoom should use.
   *
   * @param {number} zoom
   * @returns {number}
   */
  levelFor(zoom) {
    const { minZoom, maxZoom } = this.options;
    const z = Math.round(zoom);
    return z < minZoom ? minZoom : z > maxZoom ? maxZoom : z;
  }

  /**
   * Best already-built level for a zoom, or null. Never does work, so it is
   * safe to call from a render frame.
   *
   * @param {number} zoom
   * @returns {LodLevel|null}
   */
  peek(zoom) {
    const want = this.levelFor(zoom);
    const exact = this.levels.get(want);
    if (exact) {
      this._touch(want, exact);
      return exact;
    }
    let best = null;
    let bestDist = Infinity;
    for (const [z, level] of this.levels) {
      const dist = Math.abs(z - want);
      if (dist < bestDist) {
        bestDist = dist;
        best = level;
      }
    }
    return best;
  }

  /**
   * Build (or fetch) the level for a zoom. Blocking; call it off the
   * interaction path - see `WaterlinesOverlay`, which schedules it when idle.
   *
   * @param {number} zoom
   * @returns {LodLevel}
   */
  get(zoom) {
    const z = this.levelFor(zoom);
    const cached = this.levels.get(z);
    if (cached) {
      this._touch(z, cached);
      return cached;
    }
    const level = this._build(z);
    this.levels.set(z, level);
    this._evict();
    return level;
  }

  /**
   * True when `get(zoom)` would have to do work.
   *
   * @param {number} zoom
   * @returns {boolean}
   */
  isStale(zoom) {
    return !this.levels.has(this.levelFor(zoom));
  }

  /** Drop every cached level (e.g. after the curve style changes). */
  clear() {
    this.levels.clear();
  }

  // ------------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------------

  _build(z) {
    const t0 = now();
    const { tolerancePx, minRingPx, curve, alpha, flatness, createPath } = this.options;
    const refWorldSize = worldSize(z);

    const tolerance = tolerancePx / refWorldSize;
    const minSize = minRingPx / refWorldSize;
    const simplified = simplifyRings(this.rings, tolerance, minSize);

    // Path units at this level are pixels at this level's zoom, so the
    // flattening tolerance is already in the right units.
    const curveOptions = { curve, alpha, flatness };
    let vertices = 0;
    for (const ring of simplified) {
      const path = createPath();
      appendRingToPath(path, ring.coords, refWorldSize, curveOptions);
      ring.path = path;
      vertices += ring.coords.length >> 1;
    }

    return {
      zoom: z,
      refWorldSize,
      rings: simplified,
      vertices,
      buildMs: now() - t0,
    };
  }

  _touch(z, level) {
    // Map preserves insertion order, so re-inserting marks it most-recent.
    this.levels.delete(z);
    this.levels.set(z, level);
  }

  _evict() {
    const { maxCached } = this.options;
    while (this.levels.size > maxCached) {
      const oldest = this.levels.keys().next().value;
      this.levels.delete(oldest);
    }
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
