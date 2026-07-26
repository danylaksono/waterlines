/**
 * path.js
 *
 * Ring -> path conversion, including the curve smoothing that makes waterlines
 * look drawn rather than spiky.
 *
 * Why smoothing matters: the waterlines are produced by stroking the coastline
 * with a very wide pen. A wide pen amplifies every sharp corner of the source
 * geometry into a spike or a bulge, so the outer waterlines end up looking
 * nothing like a hand-drawn ripple. Olivia Vane's notebook solves this with
 * d3's `curveCatmullRomClosed`; this is a direct, dependency-free port of the
 * centripetal Catmull-Rom -> cubic Bezier conversion d3-shape performs, done
 * once per LOD rather than once per frame.
 *
 * Paths are emitted into any object with the canvas path API (`moveTo`,
 * `lineTo`, `bezierCurveTo`, `closePath`) - a real `Path2D` in the browser, a
 * recording stub in tests.
 */

const EPSILON = 1e-12;

/**
 * @typedef {Object} PathSink
 * @property {(x:number,y:number)=>void} moveTo
 * @property {(x:number,y:number)=>void} lineTo
 * @property {(c1x:number,c1y:number,c2x:number,c2y:number,x:number,y:number)=>void} bezierCurveTo
 * @property {()=>void} closePath
 */

/**
 * Append one closed ring to a path sink.
 *
 * By default the curve is **flattened to line segments here**, rather than
 * emitted as cubics for the canvas to flatten. That is not a micro-
 * optimisation: measured on a software rasteriser, the first `stroke()` of a
 * `Path2D` holding ~9,000 cubic segments cost 1.6 s, because that is when Skia
 * flattens it - and the overlay rebuilds its combined path whenever the set of
 * visible rings changes, so it would pay that repeatedly. Flattening once per
 * level of detail, in typed-array code we control, removes the spike entirely.
 *
 * @param {PathSink} sink
 * @param {Float64Array} coords interleaved, unclosed, normalised mercator
 * @param {number} scale multiply coords by this (normalised mercator -> path units)
 * @param {Object} [options]
 * @param {'catmullRom'|'linear'} [options.curve='catmullRom']
 * @param {number} [options.alpha=0.5] Catmull-Rom parameterisation; 0.5 is
 *   centripetal (no cusps or self-intersection), 0 is uniform, 1 is chordal.
 * @param {boolean} [options.flatten=true] emit line segments instead of cubics
 * @param {number} [options.flatness=0.4] flattening tolerance, in path units
 */
export function appendRingToPath(sink, coords, scale, options = {}) {
  const { curve = 'catmullRom', alpha = 0.5, flatten = true, flatness = 0.4 } = options;
  const n = coords.length >> 1;
  if (n < 3) return;

  if (curve === 'linear' || n < 4) {
    sink.moveTo(coords[0] * scale, coords[1] * scale);
    for (let i = 1; i < n; i++) {
      sink.lineTo(coords[i * 2] * scale, coords[i * 2 + 1] * scale);
    }
    sink.closePath();
    return;
  }

  appendCatmullRomClosed(sink, coords, n, scale, alpha, flatten, flatness);
}

/**
 * Build a path containing many rings.
 *
 * @param {PathSink} sink
 * @param {Array<{coords:Float64Array}>} rings
 * @param {number} scale
 * @param {Object} [options] see {@link appendRingToPath}
 */
export function appendRingsToPath(sink, rings, scale, options) {
  for (const ring of rings) appendRingToPath(sink, ring.coords, scale, options);
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

/**
 * Centripetal Catmull-Rom through every vertex of a closed ring, emitted as
 * cubic Beziers. Mirrors d3-shape's `curveCatmullRomClosed`.
 */
function appendCatmullRomClosed(sink, coords, n, scale, alpha, flatten, flatness) {
  const half = alpha / 2;

  // Chord lengths raised to alpha, cached per edge so each is computed once.
  const la = new Float64Array(n); // |P[i+1] - P[i]| ** alpha
  const l2a = new Float64Array(n); // la ** 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = coords[j * 2] - coords[i * 2];
    const dy = coords[j * 2 + 1] - coords[i * 2 + 1];
    const d2 = dx * dx + dy * dy;
    const v = Math.pow(d2, half);
    la[i] = v;
    l2a[i] = v * v;
  }

  const x = (i) => coords[(i % n) * 2] * scale;
  const y = (i) => coords[(i % n) * 2 + 1] * scale;

  sink.moveTo(x(0), y(0));

  for (let i = 0; i < n; i++) {
    // Segment P1 -> P2 with neighbours P0 and P3.
    const i0 = (i + n - 1) % n;
    const i1 = i;
    const i2 = (i + 1) % n;
    const i3 = (i + 2) % n;

    const l01a = la[i0];
    const l01_2a = l2a[i0];
    const l12a = la[i1];
    const l12_2a = l2a[i1];
    const l23a = la[i2];
    const l23_2a = l2a[i2];

    const x0 = x(i0), y0 = y(i0);
    const x1 = x(i1), y1 = y(i1);
    const x2 = x(i2), y2 = y(i2);
    const x3 = x(i3), y3 = y(i3);

    let c1x = x1;
    let c1y = y1;
    if (l01a > EPSILON) {
      const a = 2 * l01_2a + 3 * l01a * l12a + l12_2a;
      const d = 3 * l01a * (l01a + l12a);
      c1x = (x1 * a - x0 * l12_2a + x2 * l01_2a) / d;
      c1y = (y1 * a - y0 * l12_2a + y2 * l01_2a) / d;
    }

    let c2x = x2;
    let c2y = y2;
    if (l23a > EPSILON) {
      const b = 2 * l23_2a + 3 * l23a * l12a + l12_2a;
      const m = 3 * l23a * (l23a + l12a);
      c2x = (x2 * b + x1 * l23_2a - x3 * l12_2a) / m;
      c2y = (y2 * b + y1 * l23_2a - y3 * l12_2a) / m;
    }

    if (flatten) {
      flattenCubic(sink, x1, y1, c1x, c1y, c2x, c2y, x2, y2, flatness);
    } else {
      sink.bezierCurveTo(c1x, c1y, c2x, c2y, x2, y2);
    }
  }

  sink.closePath();
}

/**
 * Emit a cubic Bezier as line segments, using uniform subdivision sized by the
 * standard second-difference error bound: with `n` segments the deviation is
 * at most `(3 / (4 n^2)) * max(|P0 - 2P1 + P2|, |P1 - 2P2 + P3|)`.
 *
 * Uniform rather than recursive on purpose - it is branch-free, allocates
 * nothing, and the curves here are short spans between adjacent coastline
 * vertices, where adaptive subdivision buys nothing.
 */
function flattenCubic(sink, x0, y0, x1, y1, x2, y2, x3, y3, tolerance) {
  const ax = x0 - 2 * x1 + x2;
  const ay = y0 - 2 * y1 + y2;
  const bx = x1 - 2 * x2 + x3;
  const by = y1 - 2 * y2 + y3;
  const m = Math.max(ax * ax + ay * ay, bx * bx + by * by);

  let steps = 1;
  if (m > 0 && tolerance > 0) {
    steps = Math.ceil(Math.sqrt((0.75 * Math.sqrt(m)) / tolerance));
    if (!(steps >= 1)) steps = 1;
    if (steps > 24) steps = 24;
  }

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    sink.lineTo(
      a * x0 + b * x1 + c * x2 + d * x3,
      a * y0 + b * y1 + c * y2 + d * y3
    );
  }
}
