/**
 * style.js
 *
 * Waterline style: defaults, presets, and resolution of a partial style into
 * the fully-specified object the renderer consumes.
 *
 * Distances are in CSS pixels and measured *from the shoreline outwards*,
 * which is how you actually think about the look. (The underlying technique
 * works in stroke widths, which are twice that; the renderer does the
 * doubling so nobody else has to.)
 */

/**
 * @typedef {Object} WaterlineStyle
 * @property {number} count      number of waterlines
 * @property {number} extent     distance from shore to the outermost line, px
 * @property {number} inset      distance from shore to the innermost line, px
 * @property {number} spacingExponent  <1 bunches lines near the shore, >1 spreads them
 * @property {[number, number]} lineWidth  visible line width [innermost, outermost], px
 * @property {[number, number]} opacity    alpha [outermost, innermost]
 * @property {number} opacityExponent
 * @property {string|string[]|((t:number)=>string)} color  t=0 innermost .. t=1 outermost
 * @property {boolean} filled    true draws solid bands instead of lines
 * @property {'clip'|'fill'|'none'} land   what to do with the land interior
 * @property {string} landColor  used when land === 'fill'
 * @property {{color:string,width:number}|null} coastline
 * @property {GlobalCompositeOperation} [composite] blend mode for the lines
 * @property {CanvasLineJoin} [lineJoin='bevel'] `round` is prettier on sharp
 *   corners but markedly slower on a densely sampled coastline
 * @property {number|null} phase  where in the animation cycle to draw, 0..1,
 *   or `null` to hold still. Over one cycle every waterline travels outwards
 *   into the slot the line ahead of it occupied; 0 and 1 are the same picture,
 *   so the loop is seamless. See {@link WaterlineCycle}.
 */

/**
 * Spacing, in one place, because it is the setting people get wrong.
 *
 * The gap between the two innermost lines is roughly
 * `(extent - inset) * (1 - ((count - 1) / count) ** spacingExponent)`. Pushing
 * `count` up without pushing `extent` up with it drives that below a pixel,
 * and the ripples fuse into a dark halo instead of reading as lines. Every
 * preset below keeps the innermost gap above about 2 px.
 *
 * @type {WaterlineStyle}
 */
export const DEFAULT_STYLE = {
  count: 12,
  extent: 34,
  inset: 2,
  spacingExponent: 0.7,
  lineWidth: [0.9, 0.45],
  opacity: [0.12, 1],
  opacityExponent: 0.8,
  color: '#2f6f7e',
  filled: false,
  land: 'clip',
  landColor: '#e9dcc0',
  coastline: null,
  composite: 'source-over',
  lineJoin: 'bevel',
  phase: null,
};

/**
 * Ready-made looks. Merge over `DEFAULT_STYLE` via {@link resolveStyle}.
 *
 * @type {Record<string, Partial<WaterlineStyle>>}
 */
export const PRESETS = {
  /** Close to the Observable notebook's default teal. */
  classic: {
    color: '#2f6f7e',
    count: 10,
    extent: 30,
    inset: 2,
    spacingExponent: 0.8,
  },
  /** Engraved 19th-century chart: warm ink, fine lines crowding the coast. */
  antique: {
    color: '#6a5138',
    count: 14,
    extent: 46,
    inset: 1.5,
    spacingExponent: 0.62,
    lineWidth: [0.8, 0.4],
    opacity: [0.08, 0.95],
  },
  /** Admiralty-chart blue, wider and softer. */
  nautical: {
    color: '#2b5f8a',
    count: 9,
    extent: 52,
    inset: 3,
    spacingExponent: 0.85,
    lineWidth: [1.1, 0.6],
    opacity: [0.08, 0.9],
  },
  /** Reaching far enough that neighbouring islands' ripples meet - a soft Voronoi. */
  voronoi: {
    color: '#3b7d74',
    count: 24,
    extent: 120,
    inset: 2,
    spacingExponent: 0.95,
    lineWidth: [0.7, 0.4],
    opacity: [0.06, 0.9],
  },
  /** Solid graduated bands rather than lines - bathymetry-poster look. */
  bands: {
    filled: true,
    count: 7,
    extent: 44,
    inset: 2,
    spacingExponent: 0.7,
    color: (t) => `rgba(47, 111, 126, ${0.1 + 0.5 * t})`,
    opacity: [1, 1],
  },
};

/**
 * Merge a partial style (optionally naming a preset) onto the defaults.
 *
 * @param {Partial<WaterlineStyle> & {preset?: string}} [style]
 * @returns {WaterlineStyle}
 */
export function resolveStyle(style = {}) {
  const { preset, ...rest } = style;
  const base = preset ? PRESETS[preset] : null;
  if (preset && !base) {
    throw new Error(
      `Unknown waterline preset "${preset}". Known: ${Object.keys(PRESETS).join(', ')}`
    );
  }
  const merged = { ...DEFAULT_STYLE, ...base, ...rest };
  merged.lineWidth = toPair(merged.lineWidth, DEFAULT_STYLE.lineWidth);
  merged.opacity = toPair(merged.opacity, DEFAULT_STYLE.opacity);
  merged.phase = normalisePhase(merged.phase);
  return merged;
}

/**
 * Wrap a phase into [0, 1), so callers can drive it straight from a clock
 * (`elapsed / periodMs`) or run it backwards without bookkeeping.
 *
 * @param {number|null|undefined} phase
 * @returns {number|null}
 */
export function normalisePhase(phase) {
  if (phase === null || phase === undefined) return null;
  if (!Number.isFinite(phase)) return null;
  const p = phase % 1;
  return p < 0 ? p + 1 : p;
}

/**
 * Build the colour lookup used per waterline.
 *
 * @param {WaterlineStyle['color']} color
 * @returns {(t:number)=>string} t runs 0 (innermost) .. 1 (outermost)
 */
export function colorAccessor(color) {
  if (typeof color === 'function') return color;
  if (Array.isArray(color)) {
    const n = color.length;
    if (n === 0) return () => DEFAULT_STYLE.color;
    return (t) => color[Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))))];
  }
  return () => color;
}

function toPair(value, fallback) {
  if (typeof value === 'number') return [value, value];
  if (Array.isArray(value) && value.length === 2) return [value[0], value[1]];
  return fallback;
}
