/**
 * scales.js
 *
 * The two-line subset of d3-scale the waterline renderer needs, so the library
 * has no runtime dependencies. `powScale` is faithful to `d3.scalePow`: the
 * power transform is applied to the domain, then interpolation is linear in
 * transformed space.
 */

/**
 * @param {[number, number]} domain
 * @param {[number, number]} range
 * @param {number} [exponent=1]
 * @returns {(x:number)=>number}
 */
export function powScale(domain, range, exponent = 1) {
  const t = (v) => (v < 0 ? -Math.pow(-v, exponent) : Math.pow(v, exponent));
  const d0 = t(domain[0]);
  const d1 = t(domain[1]);
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => r0;
  return (x) => r0 + ((t(x) - d0) / span) * (r1 - r0);
}

/**
 * @param {[number, number]} domain
 * @param {[number, number]} range
 * @returns {(x:number)=>number}
 */
export function linearScale(domain, range) {
  return powScale(domain, range, 1);
}

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
