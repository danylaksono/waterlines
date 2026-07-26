/**
 * VisiblePathCache.js
 *
 * Per-frame viewport culling, with the resulting combined `Path2D` cached.
 *
 * Two things are going on here:
 *
 * 1. Culling. Indonesia is ~1100 rings; at street zoom two of them are on
 *    screen. Stroking the other 1098 costs real time for nothing, so rings are
 *    rejected by bbox against the padded viewport.
 *
 * 2. Caching. The renderer wants a *single* path: stroking one path with N
 *    sub-paths composites the union once, whereas stroking N paths composites
 *    them one after another, which double-blends wherever two islands' ripples
 *    overlap. Rebuilding that combined path every frame would undo the saving,
 *    but the visible set only changes when you pan past an island's bbox - a
 *    few times per gesture - so it is cached against a signature of the set.
 */

export class VisiblePathCache {
  /**
   * @param {Object} [options]
   * @param {() => Path2D} [options.createPath]
   */
  constructor(options = {}) {
    this.createPath = options.createPath || (() => new Path2D());
    this._level = null;
    this._signature = -1;
    this._path = null;
    this._ringCount = 0;
    this._visible = [];
  }

  /**
   * @param {import('../core/LodPyramid.js').LodLevel} level
   * @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds
   *   padded viewport, in normalised mercator
   * @returns {{path:Path2D|null, refWorldSize:number, ringCount:number, rebuilt:boolean}}
   */
  update(level, bounds) {
    if (!level) {
      this._level = null;
      this._path = null;
      this._ringCount = 0;
      return { path: null, refWorldSize: 1, ringCount: 0, rebuilt: false };
    }

    const rings = level.rings;
    const visible = this._visible;
    visible.length = 0;

    // FNV-ish rolling signature over (level, visible indices).
    let signature = (level.zoom + 1) * 2654435761;
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      if (
        r.maxX < bounds.minX ||
        r.minX > bounds.maxX ||
        r.maxY < bounds.minY ||
        r.minY > bounds.maxY
      ) {
        continue;
      }
      visible.push(r);
      signature = (signature * 31 + i) | 0;
    }
    signature = (signature * 31 + visible.length) | 0;

    if (this._level === level && this._signature === signature && this._path) {
      return {
        path: this._path,
        refWorldSize: level.refWorldSize,
        ringCount: this._ringCount,
        rebuilt: false,
      };
    }

    const path = this.createPath();
    for (const ring of visible) path.addPath(ring.path);

    this._level = level;
    this._signature = signature;
    this._path = visible.length ? path : null;
    this._ringCount = visible.length;

    return {
      path: this._path,
      refWorldSize: level.refWorldSize,
      ringCount: visible.length,
      rebuilt: true,
    };
  }

  /** Force a rebuild on the next update (e.g. after the curve style changes). */
  invalidate() {
    this._signature = -1;
    this._path = null;
    this._level = null;
  }
}
