/**
 * geometry.js
 *
 * Rings -> GPU buffers.
 *
 * The important property here is that the GL path consumes *exactly* the same
 * vertices as the 2D path. {@link RingVertexSink} implements the same sink
 * interface `appendRingToPath` writes into, so simplification, centripetal
 * Catmull-Rom and curve flattening all run through the identical code in
 * `core/path.js`. Any difference between the two renderers is therefore a
 * difference in rasterisation, not in geometry - which is what makes them
 * comparable.
 *
 * Two index sets come out of one vertex array:
 *
 *  - **edges**, a closed loop per ring, drawn as `LINES` to seed the distance
 *    field with the coastline;
 *  - **fans**, a triangle fan per ring from its own first vertex, drawn into
 *    the stencil buffer with `INVERT` to get an even-odd land mask without
 *    triangulating anything. Holes fall out for free, exactly as they do from
 *    `ctx.fill(path, 'evenodd')`.
 */

/**
 * Collects one ring's flattened outline. Drop-in for `Path2D` as far as
 * `appendRingToPath` is concerned.
 *
 * @implements {import('../core/path.js').PathSink}
 */
export class RingVertexSink {
  constructor() {
    /** @type {number[]} interleaved x,y in the level's reference pixels */
    this.coords = [];
  }

  moveTo(x, y) {
    this.coords.push(x, y);
  }

  lineTo(x, y) {
    this.coords.push(x, y);
  }

  /**
   * Only reached when `flatten: false`; the GL path always flattens, so this
   * subdivides uniformly rather than pulling in the 2D flattener's error
   * bound. Kept so the sink is a complete implementation of the interface.
   */
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    const n = this.coords.length;
    const x0 = this.coords[n - 2];
    const y0 = this.coords[n - 1];
    for (let i = 1; i <= 8; i++) {
      const t = i / 8;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      this.coords.push(
        a * x0 + b * c1x + c * c2x + d * x,
        a * y0 + b * c1y + c * c2y + d * y
      );
    }
  }

  closePath() {
    // The closing edge is generated from the index buffer, so there is nothing
    // to record. `appendRingToPath` may already have emitted a final vertex
    // coincident with the first; `buildLevelMesh` drops it.
  }

  /** @returns {number} vertices, after any duplicate closing vertex is dropped */
  get length() {
    const n = this.coords.length >> 1;
    if (n < 2) return n;
    const first = this.coords[0] === this.coords[(n - 1) * 2];
    const second = this.coords[1] === this.coords[(n - 1) * 2 + 1];
    return first && second ? n - 1 : n;
  }
}

/**
 * @typedef {Object} LevelMesh
 * @property {Float32Array} positions interleaved x,y in reference pixels
 * @property {Uint32Array} edges  LINES index pairs, one closed loop per ring
 * @property {Uint32Array} fans   TRIANGLES index triples, one fan per ring
 * @property {number} vertices
 * @property {number} rings
 */

/**
 * Pack a whole LOD level into one vertex array and two index arrays.
 *
 * The GL renderer draws the **entire level** every frame rather than culling
 * to the viewport first. That is not laziness: a few hundred thousand line
 * segments is a trivial mesh for a GPU, off-screen geometry is discarded by
 * the rasteriser for nothing, and skipping the cull removes the per-frame CPU
 * work and the visible-set cache the 2D path needs (`VisiblePathCache`).
 *
 * @param {Array<{path: RingVertexSink}>} rings a built {@link import('../core/LodPyramid.js').LodLevel}'s rings
 * @returns {LevelMesh}
 */
export function buildLevelMesh(rings) {
  let total = 0;
  let edgeCount = 0;
  let triCount = 0;
  for (const ring of rings) {
    const n = ring.path.length;
    if (n < 3) continue;
    total += n;
    edgeCount += n;
    triCount += n - 2;
  }

  const positions = new Float32Array(total * 2);
  const edges = new Uint32Array(edgeCount * 2);
  const fans = new Uint32Array(triCount * 3);

  let v = 0;
  let e = 0;
  let f = 0;
  let used = 0;
  for (const ring of rings) {
    const sink = ring.path;
    const n = sink.length;
    if (n < 3) continue;

    const base = used;
    for (let i = 0; i < n; i++) {
      positions[v++] = sink.coords[i * 2];
      positions[v++] = sink.coords[i * 2 + 1];
    }
    for (let i = 0; i < n; i++) {
      edges[e++] = base + i;
      edges[e++] = base + ((i + 1) % n);
    }
    // Fan apex is the ring's own first vertex. With stencil INVERT the apex is
    // arbitrary and the fan may be wildly non-convex; parity is all that
    // survives, and parity is exactly the even-odd rule.
    for (let i = 1; i < n - 1; i++) {
      fans[f++] = base;
      fans[f++] = base + i;
      fans[f++] = base + i + 1;
    }
    used += n;
  }

  return { positions, edges, fans, vertices: total, rings: rings.length };
}
