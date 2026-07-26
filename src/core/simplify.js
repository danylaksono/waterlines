/**
 * simplify.js
 *
 * Ramer-Douglas-Peucker simplification for closed rings held as interleaved
 * Float64Arrays.
 *
 * Closed rings have no natural endpoints, so we pin two anchors before
 * recursing: vertex 0 and the vertex furthest from it. Without that, RDP on a
 * closed ring can collapse the whole thing to a sliver.
 */

/**
 * @param {Float64Array} coords interleaved [x0,y0,x1,y1,...], ring not closed
 * @param {number} tolerance perpendicular distance, same units as coords
 * @returns {Float64Array} simplified coords, or the input if nothing to do
 */
export function simplifyRing(coords, tolerance) {
  const n = coords.length >> 1;
  if (n <= 4 || tolerance <= 0) return coords;

  const tol2 = tolerance * tolerance;
  const keep = new Uint8Array(n);

  const anchorA = 0;
  const anchorB = furthestFrom(coords, n, 0);
  if (anchorB === 0) return coords;

  keep[anchorA] = 1;
  keep[anchorB] = 1;
  rdp(coords, anchorA, anchorB, tol2, keep);
  // Second arc runs anchorB -> n -> 0; handled by treating index n as vertex 0.
  rdp(coords, anchorB, n, tol2, keep);

  let kept = 0;
  for (let i = 0; i < n; i++) kept += keep[i];
  if (kept === n) return coords;
  if (kept < 3) return coords;

  const out = new Float64Array(kept * 2);
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    out[w++] = coords[i * 2];
    out[w++] = coords[i * 2 + 1];
  }
  return out;
}

/**
 * Simplify a whole ring list and drop rings that became too small to matter.
 *
 * @param {import('./rings.js').Ring[]} rings
 * @param {number} tolerance in normalised mercator units
 * @param {number} minSize drop rings whose bbox is smaller than this
 * @returns {import('./rings.js').Ring[]}
 */
export function simplifyRings(rings, tolerance, minSize = 0) {
  const out = [];
  for (const ring of rings) {
    if (ring.size < minSize) continue;
    const coords = simplifyRing(ring.coords, tolerance);
    if (coords.length < 6) continue;
    // Always a fresh object: LOD levels cache a Path2D on the ring, and that
    // cache is only valid for one reference scale.
    out.push({ ...ring, coords });
  }
  return out;
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

function furthestFrom(coords, n, i) {
  const ax = coords[i * 2];
  const ay = coords[i * 2 + 1];
  let best = 0;
  let bestD = -1;
  for (let j = 0; j < n; j++) {
    const dx = coords[j * 2] - ax;
    const dy = coords[j * 2 + 1] - ay;
    const d = dx * dx + dy * dy;
    if (d > bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

/**
 * Iterative RDP over the half-open index range [first, last]. `last` may equal
 * `n`, meaning "wrap back to vertex 0".
 */
function rdp(coords, first, last, tol2, keep) {
  const n = keep.length;
  const stack = [first, last];

  while (stack.length) {
    const end = stack.pop();
    const start = stack.pop();
    if (end - start < 2) continue;

    const ax = coords[(start % n) * 2];
    const ay = coords[(start % n) * 2 + 1];
    const bx = coords[(end % n) * 2];
    const by = coords[(end % n) * 2 + 1];

    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let maxD = -1;
    let maxI = -1;
    for (let i = start + 1; i < end; i++) {
      const idx = (i % n) * 2;
      const px = coords[idx];
      const py = coords[idx + 1];

      let d;
      if (len2 === 0) {
        const ex = px - ax;
        const ey = py - ay;
        d = ex * ex + ey * ey;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (ax + t * dx);
        const ey = py - (ay + t * dy);
        d = ex * ex + ey * ey;
      }
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }

    if (maxD > tol2) {
      keep[maxI % n] = 1;
      stack.push(start, maxI, maxI, end);
    }
  }
}
