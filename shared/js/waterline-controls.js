/**
 * waterline-controls.js
 *
 * The waterline and performance panels, shared by every example page so they
 * stay identical. Pages differ in what sits *above* these sections - places
 * and basemaps in one, data loading and export in the other.
 *
 * Field definitions are data, not DOM: `buildPanel` in `controls.js` turns
 * them into inputs, and `styleFromValues` turns the resulting values back into
 * a waterline style.
 */

import { PRESETS, resolveStyle } from '../../src/render/style.js';

/**
 * @param {import('../../src/render/style.js').WaterlineStyle} initial
 * @param {string} ink starting colour
 * @returns {import('./controls.js').Field[]}
 */
export function waterlineFields(initial, ink) {
  return [
    {
      name: 'preset',
      label: 'Preset',
      type: 'select',
      value: 'antique',
      options: Object.keys(PRESETS).map((value) => ({
        value,
        label: value.charAt(0).toUpperCase() + value.slice(1),
      })),
    },
    {
      name: 'count',
      label: 'Line count',
      type: 'range',
      min: 2,
      max: 48,
      step: 1,
      value: initial.count,
      hint: 'Each line costs two stroke passes over the coastline path.',
    },
    {
      name: 'extent',
      label: 'Reach from shore',
      type: 'range',
      min: 4,
      max: 140,
      step: 1,
      value: initial.extent,
      format: (v) => `${v} px`,
      hint: 'Screen pixels, so the ripples look the same at every zoom.',
    },
    {
      name: 'inset',
      label: 'First line offset',
      type: 'range',
      min: 0,
      max: 12,
      step: 0.5,
      value: initial.inset,
      format: (v) => `${v} px`,
    },
    {
      name: 'spacing',
      label: 'Spacing skew',
      type: 'range',
      min: 0.15,
      max: 2,
      step: 0.05,
      value: initial.spacingExponent,
      hint: 'Below 1 crowds the lines against the shore; above 1 spreads them out.',
    },
    {
      name: 'lineWidth',
      label: 'Line weight',
      type: 'range',
      min: 0.2,
      max: 3,
      step: 0.05,
      value: initial.lineWidth[0],
      format: (v) => `${v.toFixed(2)} px`,
    },
    {
      name: 'fade',
      label: 'Outer fade',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.02,
      value: initial.opacity[0],
      format: (v) => v.toFixed(2),
      hint: 'Opacity of the outermost line; the innermost is always solid.',
    },
    { name: 'color', label: 'Ink', type: 'color', value: ink },
    { name: 'filled', label: 'Solid bands instead of lines', type: 'checkbox', value: false },
    { name: 'coastline', label: 'Draw a coastline over the top', type: 'checkbox', value: false },
  ];
}

/** @returns {import('./controls.js').Field[]} */
export function qualityFields() {
  return [
    {
      name: 'curve',
      label: 'Smoothing',
      type: 'select',
      value: 'catmullRom',
      options: [
        { value: 'catmullRom', label: 'Catmull-Rom (centripetal)' },
        { value: 'linear', label: 'None - raw vertices' },
      ],
      hint: 'Without smoothing, a wide pen turns every sharp corner into a spike.',
    },
    {
      name: 'tolerancePx',
      label: 'Simplify tolerance',
      type: 'range',
      min: 0.1,
      max: 4,
      step: 0.1,
      value: 0.6,
      format: (v) => `${v.toFixed(1)} px`,
      hint: 'Applied per level of detail, not per frame.',
    },
    {
      name: 'minRingPx',
      label: 'Drop islands under',
      type: 'range',
      min: 0.5,
      max: 12,
      step: 0.5,
      value: 1.5,
      format: (v) => `${v.toFixed(1)} px`,
    },
    {
      name: 'interactivePixelRatio',
      label: 'Resolution while moving',
      type: 'range',
      min: 0.5,
      max: 2,
      step: 0.25,
      value: 1,
      format: (v) => `${v}x`,
      hint: 'What the overlay trades away under load: sharpness, never line positions.',
    },
    { name: 'adaptive', label: 'Adapt automatically when frames run long', type: 'checkbox', value: true },
    { name: 'visible', label: 'Show waterlines', type: 'checkbox', value: true },
  ];
}

/**
 * Animation controls. Separate from the quality panel because switching this
 * on changes what the overlay costs by an order of magnitude - see
 * `WaterlineEngine#setAnimation`.
 *
 * @returns {import('./controls.js').Field[]}
 */
export function animationFields() {
  return [
    {
      name: 'animate',
      label: 'Animate the waterlines',
      type: 'checkbox',
      value: false,
      hint: 'Settling on a new view renders a whole loop of frames, so it takes longer to appear. Playback itself is free.',
    },
    {
      name: 'direction',
      label: 'Travelling',
      type: 'buttons',
      value: 'outwards',
      options: [
        { value: 'outwards', label: 'Outwards', title: 'Ripples radiating from the shore' },
        { value: 'inwards', label: 'Inwards', title: 'Waves washing ashore' },
      ],
    },
    {
      name: 'periodMs',
      label: 'One full cycle',
      type: 'range',
      min: 600,
      max: 4000,
      step: 100,
      value: 1600,
      format: (v) => `${(v / 1000).toFixed(1)} s`,
    },
    {
      name: 'frames',
      label: 'Frames per cycle',
      type: 'range',
      min: 4,
      max: 24,
      step: 1,
      value: 12,
      format: (v) => `${v}`,
      hint: 'Smoother, and proportionally more memory and more work per view.',
    },
  ];
}

/**
 * Apply an animation-panel change to the overlay.
 *
 * @param {Object} overlay
 * @param {string} name unused; every field rebuilds the same call
 * @param {*} value
 * @param {Object} values all panel values
 */
export function applyAnimationChange(overlay, name, value, values) {
  if (!values.animate) {
    overlay.setAnimation(null);
    return;
  }
  overlay.setAnimation({
    periodMs: values.periodMs,
    direction: values.direction,
    frames: values.frames,
  });
}

/**
 * Map panel values onto a waterline style.
 *
 * @param {Object} v panel values
 * @param {Object} [options]
 * @param {boolean} [options.canvasLand] let the canvas paint the land
 * @param {Object} [options.preset] resolved preset, when one is being applied
 * @returns {Partial<import('../../src/render/style.js').WaterlineStyle>}
 */
export function styleFromValues(v, options = {}) {
  const style = {
    count: v.count,
    extent: v.extent,
    inset: v.inset,
    spacingExponent: v.spacing,
    lineWidth: [v.lineWidth, v.lineWidth * 0.5],
    opacity: [v.fade, 1],
    filled: v.filled,
    land: options.canvasLand ? 'fill' : 'clip',
    coastline: v.coastline ? { color: v.color, width: 0.9, opacity: 0.85 } : null,
  };
  // A preset's colour may be a function - the `bands` preset's is - so only
  // override it when the swatch is genuinely in play.
  if (!options.preset || typeof options.preset.color === 'string') style.color = v.color;
  return style;
}

/**
 * Push a preset's values into the panel, without firing a style update per
 * slider.
 *
 * @param {Object} panel handle returned by `buildPanel`
 * @param {string} preset
 * @param {() => void} [suspend] called before, to gate the change handler
 * @param {() => void} [resume]
 * @returns {import('../../src/render/style.js').WaterlineStyle} the resolved preset
 */
export function applyPresetToPanel(panel, preset, suspend, resume) {
  const resolved = resolveStyle({ preset });
  if (suspend) suspend();
  panel.set('count', resolved.count);
  panel.set('extent', resolved.extent);
  panel.set('inset', resolved.inset);
  panel.set('spacing', resolved.spacingExponent);
  panel.set('lineWidth', resolved.lineWidth[0]);
  panel.set('fade', resolved.opacity[0]);
  panel.set('filled', resolved.filled);
  if (typeof resolved.color === 'string') panel.set('color', resolved.color);
  if (resume) resume();
  return resolved;
}

/**
 * Apply a performance-panel change to the overlay.
 *
 * @param {Object} overlay
 * @param {string} name field that changed
 * @param {*} value
 * @param {Object} values all panel values
 */
export function applyQualityChange(overlay, name, value, values) {
  switch (name) {
    case 'curve':
    case 'tolerancePx':
    case 'minRingPx':
      overlay.setLodOptions({
        curve: values.curve,
        tolerancePx: values.tolerancePx,
        minRingPx: values.minRingPx,
      });
      break;
    case 'interactivePixelRatio':
      overlay.engine.setInteractivePixelRatio(value);
      overlay.redraw();
      break;
    case 'adaptive':
      overlay.engine.setAdaptive(value);
      break;
    case 'visible':
      overlay.setVisible(value);
      break;
    default:
      break;
  }
}
