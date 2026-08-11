/**
 * relief.js
 *
 * Two invented surfaces, for the hachures to engrave when a measured one is
 * not wanted or not available.
 *
 * The tracer in `hachure.js` never asks where its height field came from. It
 * wants a grid of metres on a screen-aligned lattice and a metre scale to read
 * slopes with; everything after that - fall lines, contour rows, Lehmann's
 * widths - is the same arithmetic whether the surface was surveyed or made up.
 * That is the whole reason this file can exist as a peer of `dem.js` rather
 * than as a second rendering path.
 *
 * **Shore** takes the distance inland from the loaded coastline and bends it
 * into a profile. It needs no elevation data at all - only the polygons the
 * waterlines are already drawn from - so it works offline, on invented
 * continents, and on data that has no business having terrain at all. It is
 * honest decoration and nothing more: it says "this is land rising from the
 * sea", which is what a seventeenth-century engraver said too, having no better
 * information himself.
 *
 * **Mounds** keeps the *positions* real and throws the shape away. Peaks are
 * picked out of the DEM, then each is redrawn as an idealised hill with a flat
 * top, a steep waist and a base that fades to nothing. This is closer to how
 * relief was actually drawn before contour surveying: the mountains are where
 * the mountains are, and each is a symbol. It also generalises far harder than
 * any amount of blurring, which is what makes it hold up at small scales where
 * real terrain turns to mush.
 */

import { appendRingsToPath } from '../../src/core/path.js';
import { fieldGeometry } from './dem.js';

// --------------------------------------------------------------------------
// distance transform
// --------------------------------------------------------------------------

/**
 * Stands in for "no feature here".
 *
 * Deliberately a large *finite* number rather than `Infinity`. The parabola
 * intersection below subtracts one cost from another, and `Infinity - Infinity`
 * is `NaN`; every comparison against `NaN` is false, so the algorithm silently
 * keeps the wrong parabola and returns distances that are not merely imprecise
 * but arbitrary. It shows up as a coastline that reads as a cliff forty times
 * steeper than the one asked for.
 */
const NO_FEATURE = 1e20;

/**
 * How fast the invented shore profile eases off inland: the exponent in
 * `(1 + d/reach)^EASE`. Below one, so slope falls away from the coast without
 * ever reaching zero; well above zero, so it falls away at all. At 0.55 the
 * slope a full five `reach` inland is still about 45% of the slope at the
 * water's edge, which covers a whole island without flattening it.
 */
const EASE = 0.55;

/**
 * Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher
 * 2012), one dimension at a time.
 *
 * Exact rather than a two-pass chamfer approximation, because the fall lines
 * run straight down the gradient of this field and a chamfer's error is
 * *directional* - it biases distances along the diagonals, which would show up
 * as hachures fanning towards the corners of the screen on a perfectly round
 * island. The algorithm is linear in the number of samples either way.
 *
 * @param {Float64Array} f cost per sample, {@link NO_FEATURE} where absent
 * @param {number} n
 * @param {Float64Array} d output, same length
 * @param {Int32Array} v scratch, same length
 * @param {Float64Array} z scratch, length n + 1
 */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;

  for (let q = 1; q < n; q++) {
    // Intersection of the parabola rooted at q with the one currently on top.
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

/**
 * Distance in samples from every cell to the nearest cell where `mask` is set.
 *
 * @param {Uint8Array} mask
 * @param {number} cols
 * @param {number} rows
 * @param {boolean} [to=true] measure to cells where mask is truthy
 * @returns {Float32Array}
 */
export function distanceTransform(mask, cols, rows, to = true) {
  const n = Math.max(cols, rows);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const out = new Float64Array(cols * rows);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      out[j * cols + i] = !!mask[j * cols + i] === to ? 0 : NO_FEATURE;
    }
  }

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) f[i] = out[j * cols + i];
    edt1d(f, cols, d, v, z);
    for (let i = 0; i < cols; i++) out[j * cols + i] = d[i];
  }
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) f[j] = out[j * cols + i];
    edt1d(f, rows, d, v, z);
    for (let j = 0; j < rows; j++) out[j * cols + i] = d[j];
  }

  const result = new Float32Array(cols * rows);
  for (let k = 0; k < result.length; k++) result[k] = Math.sqrt(out[k]);
  return result;
}

// --------------------------------------------------------------------------
// shore
// --------------------------------------------------------------------------

/**
 * Rasterise the loaded polygons onto the sample lattice.
 *
 * Filled with `evenodd`, matching `rings.js`: holes are ordinary rings in that
 * representation, and the even-odd rule is what turns them back into holes
 * without anyone having to track winding order.
 */
function landMask(rings, geometry) {
  const { cols, rows, pad, step, matrix } = geometry;
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const path = new Path2D();
  appendRingsToPath(path, rings, 1, { curve: 'linear' });

  // Mercator -> screen -> sample: the map's own affine, shrunk by the sample
  // spacing and shifted by the padding, so the mask lines up with the lattice
  // the tracer walks.
  ctx.setTransform(
    matrix.a / step,
    matrix.b / step,
    matrix.c / step,
    matrix.d / step,
    (matrix.e + pad) / step,
    (matrix.f + pad) / step
  );
  ctx.fillStyle = '#fff';
  ctx.fill(path, 'evenodd');

  const { data } = ctx.getImageData(0, 0, cols, rows);
  const mask = new Uint8Array(cols * rows);
  for (let k = 0, p = 3; k < mask.length; k++, p += 4) mask[k] = data[p] > 127 ? 1 : 0;
  return mask;
}

/**
 * Land rising from the sea, with no elevation data involved.
 *
 * The surface is a function of one thing: how far a point is from open water.
 * Its gradient therefore points straight out to the nearest coast, so fall
 * lines run down to the sea by the shortest path and the hachures fan around
 * each island the way the waterlines ripple away from it - the same geometry,
 * read inwards instead of outwards.
 *
 * The profile is `(1 + d/reach)^p - 1` with `p` below one, scaled so the slope
 * *at the coast* is exactly the steepness asked for. A saturating profile - one
 * that flattens out a fixed distance inland - is the obvious choice and it does
 * not work: measured on Lombok, an exponential left ninety per cent of the
 * island below the flat-ground threshold, so the hachures clung to the beach
 * and the interior was blank. A power below one keeps some slope everywhere
 * while still easing off, which is both what land does and what lets the ink
 * cover the whole landmass, heaviest at the shore.
 *
 * The ridge - the medial axis, where the distance stops growing - is where the
 * gradient collapses, so it stays bare, exactly as an engraver would have left
 * the crest of a range.
 *
 * Everything is scaled through `groundStep`, so the picture is identical at
 * every zoom. That is a deliberate departure from the terrain source, which
 * necessarily shows more detail as you go in. This one has no detail to show.
 *
 * @param {Object} spec {@link import('./dem.js').FieldSpec} plus:
 * @param {import('../../src/core/rings.js').Ring[]} spec.rings
 * @param {number} spec.reachPx how far inland the land keeps rising, CSS px
 * @param {number} spec.steepnessDeg slope at the coast
 * @returns {import('./dem.js').HeightField}
 */
export function shoreField(spec) {
  const { rings, step, reachPx, steepnessDeg } = spec;
  const geometry = fieldGeometry(spec);
  const { cols, rows, groundStep } = geometry;

  const height = new Float32Array(cols * rows);
  if (!rings || !rings.length) {
    return { height, cols, rows, step, groundStep, tiles: 0, missing: 0 };
  }

  const mask = landMask(rings, geometry);
  const inland = distanceTransform(mask, cols, rows, false); // to the nearest sea
  const seaward = distanceTransform(mask, cols, rows, true); // to the nearest land

  const reach = Math.max(1, reachPx / step);
  const slope = Math.tan((steepnessDeg * Math.PI) / 180);
  // `amplitude * EASE / reach` is the rise per sample at the coast, so this
  // makes it exactly `slope * groundStep` - i.e. `slope` once the sample
  // spacing is divided back out.
  const amplitude = (slope * groundStep * reach) / EASE;
  const profile = (d) => amplitude * (Math.pow(1 + d / reach, EASE) - 1);

  for (let k = 0; k < height.length; k++) {
    // Mirrored below zero rather than flattened to it, so the coast is a clean
    // zero crossing. The tracer's land test is `h > 0`, and a sea held at
    // exactly zero would leave a ragged fringe of samples that interpolate to
    // just above it.
    height[k] = mask[k] ? profile(inland[k]) : -profile(seaward[k]);
  }

  return { height, cols, rows, step, groundStep, tiles: 0, missing: 0 };
}

// --------------------------------------------------------------------------
// mounds
// --------------------------------------------------------------------------

/**
 * @typedef {Object} Peak
 * @property {number} x sample coordinates
 * @property {number} y
 * @property {number} elev metres
 */

/**
 * Summits: the samples that are the highest thing within `radius` of themselves.
 *
 * Done in two stages because the direct test is too slow to run per sample -
 * a window of radius 20 is 1,681 comparisons, and there are a couple of hundred
 * thousand samples. Taking the maximum of each block first leaves a few hundred
 * candidates, and only those pay for the full window test. The answer is the
 * same; the work is three orders of magnitude smaller.
 *
 * Using a window maximum as the filter also spaces the peaks out for free:
 * two summits closer together than `radius` cannot both survive it, so the
 * mounds never pile up on one massif.
 *
 * @param {import('./dem.js').HeightField} field
 * @param {Object} options
 * @param {number} options.radius in samples
 * @param {number} [options.limit=140]
 * @returns {Peak[]} highest first
 */
export function findPeaks(field, options) {
  const { height, cols, rows } = field;
  const radius = Math.max(2, Math.round(options.radius));
  const limit = options.limit ?? 140;

  const candidates = [];
  for (let by = 0; by < rows; by += radius) {
    for (let bx = 0; bx < cols; bx += radius) {
      let best = -Infinity;
      let bi = -1;
      let bj = -1;
      for (let j = by; j < Math.min(rows, by + radius); j++) {
        for (let i = bx; i < Math.min(cols, bx + radius); i++) {
          const h = height[j * cols + i];
          if (h > best) {
            best = h;
            bi = i;
            bj = j;
          }
        }
      }
      if (bi >= 0 && best > 0) candidates.push([bi, bj, best]);
    }
  }

  const peaks = [];
  for (const [i, j, h] of candidates) {
    let dominant = true;
    for (let y = Math.max(0, j - radius); y <= Math.min(rows - 1, j + radius) && dominant; y++) {
      for (let x = Math.max(0, i - radius); x <= Math.min(cols - 1, i + radius); x++) {
        if (height[y * cols + x] > h) {
          dominant = false;
          break;
        }
      }
    }
    if (dominant) peaks.push({ x: i, y: j, elev: h });
  }

  peaks.sort((a, b) => b.elev - a.elev);
  return peaks.slice(0, limit);
}

/**
 * The profile of a drawn hill: flat on top, steepest at the waist, fading to
 * nothing at the base.
 *
 * Smoothstep, which is to say the slope is zero at both ends. That matters for
 * hachures specifically. A cone has constant slope, so every stroke on it takes
 * the same width and the hill reads as a flat disc of texture. A profile that
 * peaks in the middle gives each mound a dark band around its waist with a bare
 * summit and a bare skirt - which is exactly how an engraved hill is built, and
 * it happens here as a consequence of the surface rather than as a drawing
 * trick.
 *
 * @param {number} t 0 at the summit, 1 at the base
 * @returns {number} 1 at the summit, 0 at the base
 */
export function moundProfile(t) {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - (3 * t * t - 2 * t * t * t);
}

/**
 * Idealised hills at given positions.
 *
 * Combined with `max` rather than by summing. Summing merges neighbouring hills
 * into one swollen massif and loses the individual summits, which are the only
 * real information in the picture; taking the maximum keeps each mound intact
 * and lets them overlap along a clean seam, the way separately drawn symbols
 * do on an old sheet.
 *
 * @param {Object} spec {@link import('./dem.js').FieldSpec} plus:
 * @param {Peak[]} spec.peaks in sample coordinates
 * @param {number} spec.radiusPx base radius of the largest mound, CSS px
 * @param {number} spec.steepnessDeg slope at the waist of the largest mound
 * @returns {import('./dem.js').HeightField}
 */
export function moundField(spec) {
  const { peaks, step, radiusPx, steepnessDeg } = spec;
  const { cols, rows, groundStep } = fieldGeometry(spec);

  const height = new Float32Array(cols * rows);
  if (!peaks || !peaks.length) {
    return { height, cols, rows, step, groundStep, tiles: 0, missing: 0 };
  }

  const radius = Math.max(3, radiusPx / step);
  const slope = Math.tan((steepnessDeg * Math.PI) / 180);
  // `moundProfile` falls at 1.5 per unit of `t` at its steepest, so a mound of
  // height H over a base of R samples reaches `1.5 H / R` per sample there.
  const peakHeight = (r) => (slope * groundStep * r) / 1.5;

  const highest = peaks[0].elev;
  const lowest = peaks[peaks.length - 1].elev;
  const span = highest - lowest || 1;

  for (const peak of peaks) {
    // Bigger hills for higher summits, but never less than half size - a range
    // drawn strictly to scale puts its minor tops below the width of a stroke.
    const r = radius * (0.55 + 0.45 * ((peak.elev - lowest) / span));
    const h = peakHeight(r);

    const x0 = Math.max(0, Math.floor(peak.x - r));
    const x1 = Math.min(cols - 1, Math.ceil(peak.x + r));
    const y0 = Math.max(0, Math.floor(peak.y - r));
    const y1 = Math.min(rows - 1, Math.ceil(peak.y + r));

    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const d = Math.hypot(i - peak.x, j - peak.y);
        if (d > r) continue;
        const value = h * moundProfile(d / r);
        const k = j * cols + i;
        if (value > height[k]) height[k] = value;
      }
    }
  }

  return { height, cols, rows, step, groundStep, tiles: 0, missing: 0, peaks: peaks.length };
}
