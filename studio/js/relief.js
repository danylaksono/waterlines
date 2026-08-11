/**
 * relief.js
 *
 * An invented surface, for the hachures to engrave when a measured one is not
 * wanted.
 *
 * The tracer in `hachure.js` never asks where its height field came from. It
 * wants a grid of metres on a screen-aligned lattice and a metre scale to read
 * slopes with; everything after that - fall lines, contour rows, Lehmann's
 * widths - is the same arithmetic whether the surface was surveyed or made up.
 * That is the whole reason this file can exist as a peer of `dem.js` rather
 * than as a second rendering path.
 *
 * **Mounds** keeps the *positions* real and throws the shape away. Peaks are
 * picked out of the DEM, then each is redrawn as an idealised hill with a flat
 * top, a steep waist and a base that fades to nothing. This is closer to how
 * relief was actually drawn before contour surveying: the mountains are where
 * the mountains are, and each is a symbol. It also generalises far harder than
 * any amount of blurring, which is what makes it hold up at small scales where
 * real terrain turns to mush.
 */

import { fieldGeometry } from './dem.js';

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
