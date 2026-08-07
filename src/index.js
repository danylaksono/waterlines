/**
 * waterlines
 *
 * Old-map style waterlines drawn on a 2D canvas over a live web map.
 *
 * The technique is Olivia Vane's, from "Drawing waterlines on maps"
 * (https://observablehq.com/@oliviafvane/ii-drawing-waterlines-on-maps).
 * This package ports it out of Observable and makes it hold up on an
 * interactive map: see `render/WaterlineRenderer.js` for the algorithm and
 * `render/WaterlineEngine.js` for what it takes to run it every frame.
 *
 * Quick start (MapLibre):
 *
 *   import { WaterlinesOverlay } from 'waterlines/maplibre';
 *   const overlay = new WaterlinesOverlay(map, { data: landGeoJSON,
 *                                                style: { preset: 'antique' } });
 */

// Adapters
export { WaterlinesOverlay, addWaterlines } from './adapters/maplibre.js';
export { WaterlinesDeckOverlay } from './adapters/deckgl.js';
export {
  affineFromMap,
  affineFromViewport,
  solve as solveAffine,
} from './adapters/transform.js';

// Engine & rendering
export { WaterlineEngine } from './render/WaterlineEngine.js';
export { WaterlineRenderer, matrixScale } from './render/WaterlineRenderer.js';
export { VisiblePathCache } from './render/VisiblePathCache.js';
export { RasterCache, blitTransform, entryCovers } from './render/RasterCache.js';
export { WaterlineCycle } from './render/WaterlineCycle.js';
export { affineEquals, mercatorBounds } from './render/bounds.js';
export {
  DEFAULT_STYLE,
  PRESETS,
  colorAccessor,
  normalisePhase,
  resolveStyle,
} from './render/style.js';
export { clamp, linearScale, powScale } from './render/scales.js';

// Geometry
export { LodPyramid } from './core/LodPyramid.js';
export { countVertices, geojsonToRings, ringsBbox } from './core/rings.js';
export { simplifyRing, simplifyRings } from './core/simplify.js';
export { appendRingToPath, appendRingsToPath } from './core/path.js';
export * as mercator from './core/mercator.js';

// Standalone rendering
export { renderStill } from './still.js';
