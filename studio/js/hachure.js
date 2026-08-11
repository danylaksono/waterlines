/**
 * hachure.js
 *
 * Engraved hachures: short tapered strokes running down the fall line,
 * thickening with the slope, arranged in rows between contours - the way a
 * nineteenth-century sheet was cut, and the reason relief on an old map reads
 * as terrain rather than as shading.
 *
 * The rule is Lehmann's (1799): spacing is constant, and the ratio of ink to
 * white grows with the gradient, so a steep face goes nearly black and a plain
 * stays bare paper. That is why the `spacing` and `weight` controls are the two
 * that matter, and why there is a slope *floor* rather than a fade to nothing -
 * flat ground on a hachured map is blank, not faintly grey.
 *
 * The pipeline, and where the look actually comes from:
 *
 *  1. **Height field** - `dem.js` returns a screen-aligned grid, so everything
 *     below is plain 2D array work in screen axes. Bearing needs no handling.
 *  2. **Generalise** - a couple of box blurs. This is not a nicety. Raw SRTM
 *     traces into frizzy insect legs; the engraved look is a *generalised*
 *     surface, and this step is most of the difference between the two.
 *  3. **Trace** - evenly-spaced streamlines down the gradient, seeded steepest
 *     first and rejected when they crowd a stroke already drawn (Jobard &
 *     Lefebvre 1997). Steepest-first seeding is a departure from the paper and
 *     is deliberate: it spends the ink budget on the ground that earns it.
 *  4. **Chop into rows** - each fall line is cut where it crosses a contour.
 *     This is the step that makes it read as engraving rather than as noise:
 *     every stroke on a hillside breaks at the same elevations, so the rows
 *     line up across the slope without any explicit alignment pass.
 *  5. **Draw** - each stroke as a filled wedge, heaviest where it leaves the
 *     contour above and tapering towards the one below. All of them go into one
 *     path and one `fill()`, so twenty thousand strokes cost one rasterisation
 *     rather than twenty thousand.
 *
 * Like the waterlines this is a canvas over the map rather than a MapLibre
 * layer, and like them it is rebuilt when the view settles and merely
 * transformed while the view moves - reusing `blitTransform` from the
 * waterlines' own raster cache, so the two bitmaps slide in exact agreement.
 */

import { blitTransform } from '../../src/render/RasterCache.js';
import { affineFromMap } from '../../src/adapters/transform.js';
import { latToMercatorY, lngToMercatorX } from '../../src/core/mercator.js';
import { sampleHeightField } from './dem.js';
import { findPeaks, moundField } from './relief.js';

/** Margin around the viewport, CSS px: how far the view can pan before a rebuild. */
const PAD = 128;

/** Height-field sample spacing, CSS px. Finer than this only feeds the blur. */
const STEP = 3;

/** Wait for the view to settle before spending a rebuild on it. */
const SETTLE_MS = 140;

export const DEFAULTS = {
  /** `terrain` (measured elevation) or `mounds` (real summits, drawn hills). */
  source: 'terrain',
  // Finer than a first guess suggests. Lehmann's rule ties stroke width to the
  // spacing, so halving the spacing halves the strokes too: the texture gets
  // finer without getting lighter, which is the difference between hachures
  // that read as engraving and hachures that read as dashes.
  spacing: 5,
  // Lehmann's own limits: below 5 degrees a sheet is left bare, and 45 is where
  // it goes solid. The obvious mistake - and the one made here first - is to put
  // the ceiling somewhere near the steepest ground actually in view, which
  // doubles the ink on every hillside and makes the relief shout.
  minSlopeDeg: 5,
  maxSlopeDeg: 45,
  weight: 1,
  // About 4 mm at screen resolution, which is the longest hachure Lehmann's
  // instructions allow.
  rowLength: 13,
  generalise: 2,
  ink: '#4a3a26',
  opacity: 0.85,
  /** mounds: the slope the drawn hills are built to. */
  steepnessDeg: 22,
  /** mounds: base radius of the largest hill, CSS px. */
  moundPx: 95,
  /**
   * terrain only: raise heights as the map zooms out, so relief keeps reading.
   * Off gives true slopes, and a small-scale sheet that is nearly bare.
   */
  exaggerate: true,
};

/** Which sources need elevation tiles, and therefore the network. */
export const SOURCES_NEEDING_DEM = new Set(['terrain', 'mounds']);

// --------------------------------------------------------------------------
// field preparation
// --------------------------------------------------------------------------

/**
 * Separable box blur, in place over a scratch buffer. Two passes of a box is a
 * close enough approximation to a Gaussian for a surface nobody measures.
 *
 * @param {Float32Array} src modified in place
 * @param {number} cols
 * @param {number} rows
 * @param {number} radius in samples; 0 is a no-op
 * @param {number} passes
 */
function blur(src, cols, rows, radius, passes = 2) {
  if (radius < 1) return src;
  const tmp = new Float32Array(src.length);
  const span = radius * 2 + 1;

  for (let pass = 0; pass < passes; pass++) {
    for (let j = 0; j < rows; j++) {
      const row = j * cols;
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += src[row + clamp(i, 0, cols - 1)];
      for (let i = 0; i < cols; i++) {
        tmp[row + i] = sum / span;
        sum -= src[row + clamp(i - radius, 0, cols - 1)];
        sum += src[row + clamp(i + radius + 1, 0, cols - 1)];
      }
    }
    for (let i = 0; i < cols; i++) {
      let sum = 0;
      for (let j = -radius; j <= radius; j++) sum += tmp[clamp(j, 0, rows - 1) * cols + i];
      for (let j = 0; j < rows; j++) {
        src[j * cols + i] = sum / span;
        sum -= tmp[clamp(j - radius, 0, rows - 1) * cols + i];
        sum += tmp[clamp(j + radius + 1, 0, rows - 1) * cols + i];
      }
    }
  }
  return src;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Gradient and slope over the whole grid, by central differences.
 *
 * `gx`/`gy` are in screen axes - y grows downward - so downhill is simply
 * `-(gx, gy)`. Slope is dimensionless rise over run, which only means anything
 * because `groundStep` carried the metre scale through from the DEM.
 *
 * @param {import('./dem.js').HeightField} field
 * @returns {{gx:Float32Array, gy:Float32Array, slope:Float32Array}}
 */
function differentiate(field) {
  const { height, cols, rows, groundStep } = field;
  const gx = new Float32Array(height.length);
  const gy = new Float32Array(height.length);
  const slope = new Float32Array(height.length);
  const inv = 1 / (2 * groundStep);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const xa = height[j * cols + Math.max(0, i - 1)];
      const xb = height[j * cols + Math.min(cols - 1, i + 1)];
      const ya = height[Math.max(0, j - 1) * cols + i];
      const yb = height[Math.min(rows - 1, j + 1) * cols + i];
      const dx = (xb - xa) * inv;
      const dy = (yb - ya) * inv;
      gx[k] = dx;
      gy[k] = dy;
      slope[k] = Math.hypot(dx, dy);
    }
  }
  return { gx, gy, slope };
}

/** Bilinear lookup into a grid, at fractional sample coordinates. */
function bilinear(grid, cols, rows, x, y) {
  const x0 = clamp(Math.floor(x), 0, cols - 1);
  const y0 = clamp(Math.floor(y), 0, rows - 1);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const fx = clamp(x - x0, 0, 1);
  const fy = clamp(y - y0, 0, 1);
  return (
    grid[y0 * cols + x0] * (1 - fx) * (1 - fy) +
    grid[y0 * cols + x1] * fx * (1 - fy) +
    grid[y1 * cols + x0] * (1 - fx) * fy +
    grid[y1 * cols + x1] * fx * fy
  );
}

/**
 * Round a contour interval to a figure a surveyor would have chosen: 1, 2, 2.5
 * or 5 times a power of ten. Snapping matters because the interval is what the
 * rows *are* - an unrounded one gives the same picture but stops the rows from
 * feeling deliberate as the zoom changes.
 *
 * @param {number} raw metres
 * @returns {number} metres
 */
export function snapInterval(raw) {
  const decade = Math.pow(10, Math.floor(Math.log10(Math.max(1e-3, raw))));
  const mantissa = raw / decade;
  const snapped = mantissa <= 1.5 ? 1 : mantissa <= 3 ? 2 : mantissa <= 4 ? 2.5 : 5;
  return Math.max(1, snapped * decade);
}

/**
 * The sample spacing at which measured terrain is drawn at its true height.
 * About 60 m, which is the ground a sample covers around zoom 12 - the scale
 * the tracer's defaults were tuned at.
 */
export const TRUE_SCALE_GROUND_STEP = 60;

/**
 * How fast measured slope falls away as the baseline it is measured over grows.
 *
 * Not a guess. Sampling one volcano at eight zooms and taking the 75th
 * percentile slope over land each time gives 30.2 degrees at 28 m per sample,
 * 12.7 at 113 m, 7.8 at 454 m and 1.9 at 3.6 km - a factor of about 1.5 for
 * every halving of the baseline, i.e. `slope ~ L^-0.585`. That is the fractal
 * signature of real ground, and it is why terrain looks wrong zoomed out rather
 * than merely coarse.
 */
export const RELIEF_FALLOFF = 0.585;

/**
 * How much to multiply measured heights by, to hold relief across zooms.
 *
 * The problem this solves is not a loss of fidelity, which is the intuitive
 * reading and the wrong one. Slope is a ratio measured over a baseline, and
 * zooming out grows the baseline: at 1.8 km per sample the flanks of a 3,700 m
 * volcano genuinely average three degrees. Nothing is being thrown away - the
 * gentle number is correct - but a hachure map drawn from it is bare, because
 * three degrees *is* flat ground and the tracer rightly refuses to ink it.
 *
 * So the answer is not to recover detail but to exaggerate, which is exactly
 * what an engraver did on a small-scale sheet and what a physical relief model
 * still does. Undoing the falloff measured above holds the 75th-percentile
 * slope near 20 degrees from zoom 6 to zoom 13, so the ink on a hillside stops
 * depending on how far out the map is.
 *
 * Applies to measured terrain only. The invented surfaces in `relief.js` are
 * built to a stated steepness through the map scale already, so they are
 * scale-invariant by construction and exaggerating them would break that.
 *
 * @param {number} groundStep metres per sample
 * @returns {number} 1 at the true-scale spacing, more when zoomed out
 */
export function reliefExaggeration(groundStep) {
  return Math.pow(Math.max(1, groundStep) / TRUE_SCALE_GROUND_STEP, RELIEF_FALLOFF);
}

/**
 * The contour interval that puts rows roughly `rowPx` apart on screen.
 *
 * Choosing the interval from the relief alone - so many bands between the
 * lowest ground and the highest - is the obvious thing and it is wrong, because
 * how far apart two contours land on *paper* depends on the slope between them
 * and on the map scale, neither of which the relief knows about. On a 20° flank
 * at 130 m per pixel, a 100 m interval puts its rows two pixels apart and the
 * hachures come out as stipple. Inverting the relationship instead - contours
 * are `dh / slope` metres apart on the ground, hence `dh / (slope * mpp)` px on
 * screen - gives an interval that holds the rows at a constant, legible length
 * however far in you zoom, which is what an engraver would have done by
 * choosing a different interval for each sheet.
 *
 * @param {number} rowPx wanted row spacing on screen, CSS px
 * @param {number} metresPerPx map scale
 * @param {number} slope representative gradient, rise over run
 * @returns {number} metres
 */
export function rowInterval(rowPx, metresPerPx, slope) {
  return snapInterval(rowPx * metresPerPx * Math.max(1e-4, slope));
}

/**
 * A gradient percentile over the ground that will carry hachures.
 *
 * The interval is sized off the *steep* end rather than the middle, and that
 * choice is worth stating because the obvious one is wrong. Row length runs as
 * `interval / slope`, so a single interval cannot suit both a cliff and a
 * plain. Size it on the median and the steep ground - where nearly all the
 * strokes are, and where the eye goes - is cut into specks, while the plains
 * get tidy rows nobody looks at. Size it high and the steep ground reads
 * properly, while gentle ground draws long strokes, which is what a long fall
 * line down a gentle slope should look like anyway.
 *
 * Taken from a histogram: the exact value never matters, only its order.
 */
function percentileSlope(slope, height, minSlope, p) {
  const BINS = 256;
  const bins = new Int32Array(BINS);
  let total = 0;
  // 2 rise-over-run is 63°, steeper than any real hillside worth binning
  // separately; everything above lands in the top bin.
  const scale = BINS / 2;

  for (let k = 0; k < slope.length; k++) {
    if (height[k] <= 0 || slope[k] < minSlope) continue;
    bins[Math.min(BINS - 1, Math.floor(slope[k] * scale))]++;
    total++;
  }
  if (!total) return 0;

  let seen = 0;
  for (let b = 0; b < BINS; b++) {
    seen += bins[b];
    if (seen >= total * p) return (b + 0.5) / scale;
  }
  return 0;
}

// --------------------------------------------------------------------------
// spacing
// --------------------------------------------------------------------------

/**
 * The constraint that makes hachures hachures: a new stroke may not come
 * closer than `dsep` to one already placed.
 *
 * A uniform bucket grid at exactly `dsep` means any point within `dsep` of a
 * candidate must lie in one of the nine cells around it, so the test is nine
 * short array scans rather than a search.
 */
class Spacing {
  /**
   * @param {number} width  extent in sample units
   * @param {number} height extent in sample units
   * @param {number} dsep   separation in sample units
   */
  constructor(width, height, dsep) {
    this.dsep = dsep;
    this.cols = Math.max(1, Math.ceil(width / dsep));
    this.rows = Math.max(1, Math.ceil(height / dsep));
    this.buckets = new Array(this.cols * this.rows);
  }

  add(x, y) {
    const cx = clamp(Math.floor(x / this.dsep), 0, this.cols - 1);
    const cy = clamp(Math.floor(y / this.dsep), 0, this.rows - 1);
    const k = cy * this.cols + cx;
    (this.buckets[k] || (this.buckets[k] = [])).push(x, y);
  }

  /** @returns {boolean} true when nothing already placed lies within `d` */
  isFree(x, y, d) {
    const cx = clamp(Math.floor(x / this.dsep), 0, this.cols - 1);
    const cy = clamp(Math.floor(y / this.dsep), 0, this.rows - 1);
    const d2 = d * d;
    for (let j = Math.max(0, cy - 1); j <= Math.min(this.rows - 1, cy + 1); j++) {
      for (let i = Math.max(0, cx - 1); i <= Math.min(this.cols - 1, cx + 1); i++) {
        const bucket = this.buckets[j * this.cols + i];
        if (!bucket) continue;
        for (let p = 0; p < bucket.length; p += 2) {
          const dx = bucket[p] - x;
          const dy = bucket[p + 1] - y;
          if (dx * dx + dy * dy < d2) return false;
        }
      }
    }
    return true;
  }
}

// --------------------------------------------------------------------------
// tracing
// --------------------------------------------------------------------------

/**
 * @typedef {Object} HachureStroke
 * @property {number[]} points x, y pairs in sample units
 * @property {number[]} widths CSS px, one per point
 */

/**
 * Trace fall lines and cut them into engraved strokes.
 *
 * @param {import('./dem.js').HeightField} field
 * @param {Object} options resolved control values
 * @returns {{strokes: HachureStroke[], interval: number, relief: number}}
 */
export function buildStrokes(field, options) {
  const { cols, rows, step } = field;
  const { spacing, minSlopeDeg, maxSlopeDeg, weight, rowLength, generalise } = {
    ...DEFAULTS,
    ...options,
  };

  const height = blur(field.height.slice(), cols, rows, Math.round(generalise), 2);
  const { gx, gy, slope } = differentiate({ ...field, height });

  // Relief over land only. Sea is genuinely negative in this DEM, so the test
  // doubles as the land mask that keeps hachures off the water.
  let relief = 0;
  let land = 0;
  for (let k = 0; k < height.length; k++) {
    if (height[k] <= 0) continue;
    land++;
    if (height[k] > relief) relief = height[k];
  }
  if (!land) return { strokes: [], interval: 0, relief: 0 };

  const dsep = Math.max(0.6, spacing / step);
  const minSlope = Math.tan((minSlopeDeg * Math.PI) / 180);

  const typical = percentileSlope(slope, height, minSlope, 0.75);
  if (!typical) return { strokes: [], interval: 0, relief };
  const interval = rowInterval(rowLength, field.groundStep / step, typical);

  // Hysteresis: a stroke may run on into ground gentler than it could have
  // been seeded on, so fall lines end where the hill does rather than at a
  // ragged edge along the seeding threshold.
  const stopSlope = minSlope * 0.55;
  const maxSlope = Math.tan((maxSlopeDeg * Math.PI) / 180);

  const placed = new Spacing(cols, rows, dsep);
  const traceStep = 0.5;
  const maxSteps = Math.ceil(Math.max(cols, rows) * 0.6 / traceStep);

  const at = (grid, x, y) => bilinear(grid, cols, rows, x, y);

  /**
   * March from a seed until the hill runs out or another stroke is in the way.
   *
   * @param {number} sx
   * @param {number} sy
   * @param {number} sign -1 downhill, +1 uphill
   * @returns {number[]} x, y, h triples
   */
  function march(sx, sy, sign) {
    const out = [];
    let x = sx;
    let y = sy;
    let px = 0;
    let py = 0;

    for (let n = 0; n < maxSteps; n++) {
      if (x < 0 || y < 0 || x > cols - 1 || y > rows - 1) break;
      const h = at(height, x, y);
      if (h <= 0) break;

      const s = at(slope, x, y);
      if (s < stopSlope) break;

      let dx = (sign * at(gx, x, y)) / s;
      let dy = (sign * at(gy, x, y)) / s;
      // A reversal means the line has walked into a pit or over a summit,
      // where the gradient is undefined and the integrator would otherwise
      // oscillate on the spot.
      if (n > 0 && dx * px + dy * py < 0) break;

      out.push(x, y, h);

      // Midpoint (RK2). Euler alone visibly cuts corners on a ridge, which
      // shows up as strokes that drift off the fall line.
      const mx = x + dx * traceStep * 0.5;
      const my = y + dy * traceStep * 0.5;
      if (mx >= 0 && my >= 0 && mx <= cols - 1 && my <= rows - 1) {
        const ms = at(slope, mx, my);
        if (ms > 1e-9) {
          dx = (sign * at(gx, mx, my)) / ms;
          dy = (sign * at(gy, mx, my)) / ms;
        }
      }

      // Only the parts of the line beyond its own first few steps can be
      // judged against the neighbours; the seed itself was already cleared.
      if (n > 2 && !placed.isFree(x, y, dsep * 0.92)) break;

      px = dx;
      py = dy;
      x += dx * traceStep;
      y += dy * traceStep;
    }
    return out;
  }

  const strokes = [];
  const seedStride = Math.max(1, Math.floor(dsep * 0.7));

  for (const [i, j] of seedOrder(slope, height, cols, rows, seedStride, minSlope)) {
    if (!placed.isFree(i, j, dsep)) continue;

    const up = march(i, j, +1);
    const down = march(i, j, -1);
    // Uphill run reversed and joined to the downhill one, so a stroke is cut
    // from the whole fall line through the seed rather than starting at it.
    const line = [];
    for (let p = up.length - 3; p >= 0; p -= 3) line.push(up[p], up[p + 1], up[p + 2]);
    for (let p = 3; p < down.length; p += 3) line.push(down[p], down[p + 1], down[p + 2]);
    if (line.length < 9) continue;

    for (let p = 0; p < line.length; p += 3) placed.add(line[p], line[p + 1]);

    cut(line, interval, dsep, traceStep, (piece) => {
      const stroke = shape(piece, { slope, cols, rows, dsep, step, maxSlope, weight });
      if (stroke) strokes.push(stroke);
    });
  }

  return { strokes, interval, relief };
}

/**
 * Seed positions, steepest ground first.
 *
 * Bucketed rather than sorted: a full sort of a couple of hundred thousand
 * samples costs more than everything else in this file put together, and only
 * the coarse ordering matters. Within a bucket the walk strides by a number
 * coprime to the count, so a bucket is consumed in a scattered order instead of
 * raster order - otherwise the spacing rule fills the top-left of the screen
 * first and the bias is visible.
 *
 * @returns {Generator<[number, number]>}
 */
function* seedOrder(slope, height, cols, rows, stride, minSlope) {
  const BUCKETS = 24;
  const candidates = [];
  for (let b = 0; b < BUCKETS; b++) candidates.push([]);

  let steepest = minSlope;
  for (let k = 0; k < slope.length; k++) {
    if (height[k] > 0 && slope[k] > steepest) steepest = slope[k];
  }

  for (let j = 0; j < rows; j += stride) {
    for (let i = 0; i < cols; i += stride) {
      const k = j * cols + i;
      if (height[k] <= 0 || slope[k] < minSlope) continue;
      const t = (slope[k] - minSlope) / (steepest - minSlope || 1);
      const bucket = Math.min(BUCKETS - 1, Math.floor(t * BUCKETS));
      candidates[bucket].push(k);
    }
  }

  for (let b = BUCKETS - 1; b >= 0; b--) {
    const list = candidates[b];
    const n = list.length;
    if (!n) continue;
    const skip = coprimeStride(n);
    for (let c = 0, at = 0; c < n; c++, at = (at + skip) % n) {
      const k = list[at];
      yield [k % cols, Math.floor(k / cols)];
    }
  }
}

/** A stride near the golden ratio of `n` that shares no factor with it. */
function coprimeStride(n) {
  let s = Math.max(1, Math.floor(n * 0.618));
  while (s > 1 && gcd(s, n) !== 1) s--;
  return s || 1;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Cut a fall line where it crosses a contour, and hand back each piece trimmed
 * back from the crossing so the rows read as separate strokes.
 *
 * @param {number[]} line x, y, h triples
 * @param {number} interval contour interval, metres
 * @param {number} dsep separation in sample units
 * @param {number} traceStep integration step in sample units
 * @param {(piece:number[]) => void} emit
 */
function cut(line, interval, dsep, traceStep, emit) {
  let start = 0;
  let band = Math.floor(line[2] / interval);

  const flush = (end) => {
    const piece = line.slice(start, end);
    const length = (piece.length / 3 - 1) * traceStep;

    // White between one row and the next, so the rows read as rows - but a
    // fraction of the row rather than a fixed width. Steep ground crowds its
    // contours together, so a gap set in absolute terms eats a short row
    // entirely and the hillside that most needs ink turns to dots.
    const trimmed = trim(piece, Math.min(dsep * 0.35, length * 0.22), traceStep);

    // Lehmann again: a hachure is never shorter than the gap to its neighbour.
    // Anything below that reads as a speck rather than a stroke, and a field of
    // specks is most of what makes generated hachures look unlike drawn ones.
    if (trimmed.length >= 6 && (trimmed.length / 3 - 1) * traceStep >= dsep) {
      emit(trimmed);
    }
  };

  for (let p = 3; p < line.length; p += 3) {
    const next = Math.floor(line[p + 2] / interval);
    if (next === band) continue;
    flush(p);
    start = p;
    band = next;
  }
  flush(line.length);
}

/**
 * Drop `by` sample units from each end of an x, y, h polyline.
 *
 * Rounding down, so a row too short to give up a whole integration step keeps
 * all of it. That is deliberate rather than a rounding convenience: rows get
 * short exactly where the ground is steepest, and steep ground is where rows
 * are *supposed* to close up into something near solid. Forcing a gap there
 * inverts the whole rule and turns the steepest face on the map into the
 * palest part of it.
 */
function trim(piece, by, traceStep) {
  const drop = Math.floor(by / traceStep);
  const count = piece.length / 3;
  if (!drop || count - 2 * drop < 2) return piece;
  return piece.slice(drop * 3, (count - drop) * 3);
}

/**
 * Give a piece its width: Lehmann's ratio from the slope, wedged so the stroke
 * is thin where it leaves the contour above and full where it meets the one
 * below. The wedge is what stops a field of hachures reading as hatching.
 *
 * @returns {HachureStroke|null}
 */
function shape(piece, ctx) {
  const { slope, cols, rows, dsep, step, maxSlope, weight } = ctx;
  const count = piece.length / 3;
  const points = new Array(count * 2);
  const widths = new Array(count);

  for (let n = 0; n < count; n++) {
    const x = piece[n * 3];
    const y = piece[n * 3 + 1];
    points[n * 2] = x;
    points[n * 2 + 1] = y;

    const s = bilinear(slope, cols, rows, x, y);
    // Ink-to-white, straight off Lehmann: the proportion of black is the slope
    // as a fraction of 45 degrees, so 45 is solid and a gentle slope is mostly
    // paper. Held just short of solid at the top so the steepest faces keep a
    // trace of fall-line direction rather than blocking in, and allowed to go
    // very fine at the bottom, where the only strokes are the tails that ran on
    // past the seeding threshold.
    const ratio = clamp(s / maxSlope, 0.04, 0.9);
    // Heaviest where the stroke leaves the contour above, tapering as it falls
    // towards the one below. Two caveats worth being straight about: the
    // sources consulted describe Lehmann's thicknesses but not which end of a
    // hachure carries them, and the difference on screen is subtle at any
    // spacing you would actually use. The reason to prefer it is structural
    // rather than historical - putting the weight at the top of every row
    // darkens the same elevation across a whole hillside, which reinforces the
    // contour banding the rows are cut on. Flip the sign to reverse it.
    const taper = 1 - 0.55 * (n / Math.max(1, count - 1));
    widths[n] = dsep * step * ratio * weight * taper;
  }

  return widths.some((w) => w > 0.25) ? { points, widths } : null;
}

// --------------------------------------------------------------------------
// drawing
// --------------------------------------------------------------------------

/**
 * Subpaths per `fill()`. Measured, not guessed: on 5,653 strokes at 1696x1156,
 * one path for the lot takes 1,821 ms, batches of 500 take 198, batches of 128
 * take 140, and one stroke per fill takes 223. The curve has a floor in the
 * middle because the two costs pull opposite ways - per-call overhead wants
 * large batches, while the rasteriser's edge list is superlinear in the size of
 * a single path, so one enormous path is thirteen times slower than the right
 * batch. This is the difference between a rebuild the map hides behind its
 * settle delay and one the user watches happen.
 */
const FILL_BATCH = 128;

/**
 * Paint strokes into a context already scaled to CSS pixels.
 *
 * Each stroke is outlined as a polygon rather than stroked with a `lineWidth`.
 * Stroking cannot vary the width *within* a stroke, and the wedge - thin where
 * the row leaves the contour above, full where it meets the one below - is
 * most of what makes these read as hachures rather than as hatching.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HachureStroke[]} strokes positions in sample units
 * @param {number} step CSS px per sample unit
 * @param {{ink:string, opacity:number}} paint
 */
export function drawStrokes(ctx, strokes, step, paint) {
  ctx.save();
  ctx.globalAlpha = paint.opacity;
  ctx.fillStyle = paint.ink;

  for (let batch = 0; batch < strokes.length; batch += FILL_BATCH) {
    const end = Math.min(strokes.length, batch + FILL_BATCH);
    ctx.beginPath();

    for (let s = batch; s < end; s++) {
      const { points, widths } = strokes[s];
      const count = points.length / 2;

      // One side out, the other back: a closed outline of the wedge.
      for (let pass = 0; pass < 2; pass++) {
        for (let n = 0; n < count; n++) {
          const i = pass === 0 ? n : count - 1 - n;
          const x = points[i * 2] * step;
          const y = points[i * 2 + 1] * step;

          // Tangent from the neighbours, so the outline stays smooth at joins.
          const a = Math.max(0, i - 1);
          const b = Math.min(count - 1, i + 1);
          let tx = (points[b * 2] - points[a * 2]) * step;
          let ty = (points[b * 2 + 1] - points[a * 2 + 1]) * step;
          const len = Math.hypot(tx, ty) || 1;
          tx /= len;
          ty /= len;

          const half = (widths[i] / 2) * (pass === 0 ? 1 : -1);
          const px = x - ty * half;
          const py = y + tx * half;
          if (pass === 0 && n === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      }
      ctx.closePath();
    }
    ctx.fill();
  }

  ctx.restore();
}

// --------------------------------------------------------------------------
// map layer
// --------------------------------------------------------------------------

/**
 * Attach a hachure canvas to a map.
 *
 * Mirrors `createRhumb`'s shape - `setEnabled`, `setOptions`, `getStats` - so
 * the studio wires the two the same way, even though one is vector geometry on
 * the GPU and this is a bitmap.
 *
 * @param {Object} map MapLibre map
 * @param {Object} [options] see {@link DEFAULTS}, plus `enabled`
 * @returns {Object} handle
 */
export function createHachures(map, options = {}) {
  const state = { enabled: false, ...DEFAULTS, ...options };

  const container = map.getCanvasContainer
    ? map.getCanvasContainer()
    : map.getContainer();

  const canvas = document.createElement('canvas');
  canvas.className = 'hachure-canvas';
  Object.assign(canvas.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    transformOrigin: '0 0',
    pointerEvents: 'none',
    display: 'none',
  });
  // Under the waterlines: the ripples are the picture, the relief is its
  // ground. Appending would put it on top, and a renderer swap re-appends the
  // waterlines canvas, so this ordering survives one.
  const waterlines = container.querySelector('.waterlines-canvas');
  if (waterlines) container.insertBefore(canvas, waterlines);
  else container.appendChild(canvas);

  const ctx = canvas.getContext('2d', { alpha: true });

  /** The view the current bitmap was built for; null when there is none. */
  let entry = null;
  let token = 0;
  let timer = null;
  let stats = { strokes: 0, tiles: 0, missing: 0, demZoom: 0, interval: 0, pending: false };
  let onStatus = options.onStatus || (() => {});
  /** Supplied summits for `mounds`, or null to extract them from the DEM. */
  let peakList = options.peaks || null;

  const size = () => {
    const gl = map.getCanvas();
    return { width: gl.clientWidth, height: gl.clientHeight };
  };

  /**
   * Project a supplied peak list onto the sample lattice.
   *
   * This is the seam an external summit list arrives through - a nationwide
   * H3/DuckDB extract, a gazetteer, a hand-placed set of hills. With one
   * supplied, `mounds` never touches the network: the only thing the DEM was
   * being fetched for was to find the summits, and someone else has done that
   * better and offline.
   */
  function projectPeaks(list, spec) {
    const { matrix, pad, step } = spec;
    const out = [];
    for (const peak of list) {
      const mx = lngToMercatorX(peak.lng);
      const my = latToMercatorY(peak.lat);
      out.push({
        x: (matrix.a * mx + matrix.c * my + matrix.e + pad) / step,
        y: (matrix.b * mx + matrix.d * my + matrix.f + pad) / step,
        elev: peak.elev ?? 1,
      });
    }
    // Highest first, matching `findPeaks`, since `moundField` sizes hills off
    // the first and last entries.
    return out.sort((a, b) => b.elev - a.elev);
  }

  /**
   * Raise a measured surface so its relief reads at the scale it is drawn at.
   *
   * The true relief is measured first and carried alongside, so the status line
   * can report the ground rather than the drawing - the whole point of an
   * exaggeration is that it is stated, not hidden.
   *
   * Scaling the heights rather than lowering the slope thresholds also keeps
   * the rows right for free: `rowInterval` is linear in slope, so the interval
   * grows by the same factor and the row length on screen does not move.
   *
   * @param {import('./dem.js').HeightField} field
   * @param {boolean} on
   */
  function exaggerate(field, on) {
    let relief = 0;
    for (const h of field.height) if (h > relief) relief = h;
    if (!on) return { ...field, trueRelief: relief, exaggeration: 1 };

    const factor = reliefExaggeration(field.groundStep);
    const height = new Float32Array(field.height.length);
    for (let k = 0; k < height.length; k++) height[k] = field.height[k] * factor;
    return { ...field, height, trueRelief: relief, exaggeration: factor };
  }

  /**
   * Produce the surface the tracer will engrave, from whichever source is
   * selected. Only `terrain` and an unsupplied `mounds` need the network.
   *
   * @returns {Promise<import('./dem.js').HeightField|null>} null if superseded
   */
  async function buildField(spec, mine) {
    const mound = (peaks, extra) => ({
      ...moundField({
        ...spec,
        peaks,
        radiusPx: state.moundPx,
        steepnessDeg: state.steepnessDeg,
      }),
      ...extra,
    });

    if (state.source === 'mounds' && peakList) {
      return mound(projectPeaks(peakList, spec), { supplied: true });
    }

    const dem = await sampleHeightField({
      ...spec,
      cancelled: () => mine !== token,
    });
    if (!dem || mine !== token) return null;
    if (state.source === 'terrain') return exaggerate(dem, state.exaggerate);

    // Summits from the measured surface, then the surface thrown away.
    //
    // Summits are sought at *half* the mound radius, so neighbouring hills
    // overlap by half and merge, through `moundField`'s maximum, into ranges
    // with several tops. Searching at the full radius instead leaves every
    // hill standing alone, and a page of isolated radially symmetric mounds
    // reads as a scatter of rosettes rather than as mountains.
    const peaks = findPeaks(dem, { radius: state.moundPx / (2 * spec.step) });
    return mound(peaks, {
      demZoom: dem.demZoom,
      tiles: dem.tiles,
      missing: dem.missing,
    });
  }

  /**
   * Rebuild for the view as it stands. Everything before the first `await` is
   * captured, so a view change mid-flight cannot half-apply.
   */
  async function refresh() {
    if (!state.enabled) return;
    const mine = ++token;

    const { width, height } = size();
    if (!width || !height) return;
    const matrix = affineFromMap(map);
    const centre = map.getCenter();

    stats = { ...stats, pending: true };
    onStatus(stats);

    const spec = {
      matrix,
      width,
      height,
      pad: PAD,
      step: STEP,
      lat: centre.lat,
    };

    let field;
    try {
      field = await buildField(spec, mine);
    } catch (error) {
      stats = { ...stats, pending: false, error: error.message };
      onStatus(stats);
      return;
    }
    if (!field || mine !== token || !state.enabled) return;

    const built = buildStrokes(field, state);
    if (mine !== token || !state.enabled) return;

    const dpr = window.devicePixelRatio || 1;
    const w = width + 2 * PAD;
    const h = height + 2 * PAD;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawStrokes(ctx, built.strokes, STEP, { ink: state.ink, opacity: state.opacity });

    entry = { matrix, width: w, height: h };
    canvas.style.display = '';
    place();

    stats = {
      source: state.source,
      strokes: built.strokes.length,
      tiles: field.tiles || 0,
      missing: field.missing || 0,
      demZoom: field.demZoom || 0,
      peaks: field.peaks || 0,
      supplied: !!field.supplied,
      interval: built.interval,
      // The ground, not the drawing: `built.relief` is the exaggerated figure.
      relief: field.trueRelief ?? built.relief,
      exaggeration: field.exaggeration || 1,
      pending: false,
    };
    onStatus(stats);
  }

  /**
   * Slide and scale the existing bitmap to match the live view. The same
   * arithmetic the waterlines' raster cache uses to blit, applied as a CSS
   * transform instead - so a pan costs a compositor matrix, not a rebuild.
   */
  function place() {
    if (!entry) return;
    const t = blitTransform(entry, affineFromMap(map), PAD);
    canvas.style.transform = `matrix(${t.a}, ${t.b}, ${t.c}, ${t.d}, ${t.e}, ${t.f})`;
  }

  function schedule() {
    if (!state.enabled) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, SETTLE_MS);
  }

  map.on('render', place);
  map.on('moveend', schedule);
  map.on('zoomend', schedule);
  map.on('rotateend', schedule);
  map.on('resize', schedule);

  const handle = {
    /** @param {boolean} on */
    setEnabled(on) {
      if (on === state.enabled) return handle;
      state.enabled = on;
      if (on) {
        refresh();
      } else {
        token++;
        clearTimeout(timer);
        entry = null;
        canvas.style.display = 'none';
        stats = { ...stats, strokes: 0, pending: false };
        onStatus(stats);
      }
      return handle;
    },

    /**
     * Colour and opacity are properties of the existing bitmap, so unlike the
     * rhumb layer there is no cheap repaint - every change is a rebuild. It is
     * a few hundred milliseconds off a cached DEM, which is why the controls
     * are debounced rather than live.
     *
     * @param {Object} patch
     */
    setOptions(patch) {
      Object.assign(state, patch);
      if (state.enabled) schedule();
      return handle;
    },

    /** Force a rebuild and resolve when the bitmap is current - used by export. */
    async render() {
      clearTimeout(timer);
      if (!state.enabled) return null;
      await refresh();
      return handle.snapshot();
    },

    /**
     * The visible rectangle, at device resolution, cropped out of the padded
     * bitmap - what the PNG export composites. Returns null when the layer is
     * off or has nothing yet.
     *
     * @returns {HTMLCanvasElement|null}
     */
    snapshot() {
      if (!state.enabled || !entry) return null;
      const { width, height } = size();
      const dpr = canvas.width / entry.width;
      const out = document.createElement('canvas');
      out.width = Math.round(width * dpr);
      out.height = Math.round(height * dpr);
      out.getContext('2d').drawImage(
        canvas,
        Math.round(PAD * dpr),
        Math.round(PAD * dpr),
        out.width,
        out.height,
        0,
        0,
        out.width,
        out.height
      );
      return out;
    },

    isEnabled: () => state.enabled,

    /** Whether a summit list has been supplied, which takes `mounds` offline. */
    hasSuppliedPeaks: () => !!peakList,

    /**
     * Supply the summits for the `mounds` source, instead of having them
     * picked out of the DEM.
     *
     * This is where a precomputed extract belongs - the H3/DuckDB kind, say,
     * which can apply a real prominence test over a whole country rather than a
     * window maximum over one screenful, and which costs no network here
     * because the answer is already in hand.
     *
     * @param {Array<{lng:number, lat:number, elev?:number}>|null} peaks
     */
    setPeaks(peaks) {
      peakList = peaks && peaks.length ? peaks : null;
      if (state.enabled && state.source === 'mounds') schedule();
      return handle;
    },

    /** @param {(stats:Object) => void} fn */
    onStatus(fn) {
      onStatus = fn;
      return handle;
    },

    getStats: () => ({ enabled: state.enabled, ...stats }),

    remove() {
      token++;
      clearTimeout(timer);
      map.off('render', place);
      map.off('moveend', schedule);
      map.off('zoomend', schedule);
      map.off('rotateend', schedule);
      map.off('resize', schedule);
      canvas.remove();
    },
  };

  return handle;
}
