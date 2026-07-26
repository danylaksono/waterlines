/**
 * rings.js
 *
 * Turns GeoJSON into the flat, typed representation the renderer wants:
 * a list of closed rings in normalised Web Mercator, each with a cached bbox.
 *
 * The renderer never looks at features, holes or winding order:
 *  - waterlines are strokes, so winding is irrelevant;
 *  - the land mask is filled with the `evenodd` rule, so holes fall out for
 *    free as long as they are present as ordinary rings.
 *
 * That means a single flat ring list is a complete description of the input,
 * and it is also the cheapest thing to cull and simplify.
 */

import { latToMercatorY, lngToMercatorX } from './mercator.js';

/**
 * @typedef {Object} Ring
 * @property {Float64Array} coords Interleaved [x0,y0,x1,y1,...] in normalised
 *   mercator. The ring is closed implicitly: the last point is NOT repeated.
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 * @property {number} size Larger bbox side, in normalised mercator units.
 *   Used as the LOD culling metric.
 */

/**
 * Convert a GeoJSON object (Feature, FeatureCollection, Geometry) into rings.
 *
 * @param {Object} geojson
 * @returns {Ring[]}
 */
export function geojsonToRings(geojson) {
  const rings = [];
  eachPolygon(geojson, (polygon) => {
    for (const lngLatRing of polygon) {
      const ring = buildRing(lngLatRing);
      if (ring) rings.push(ring);
    }
  });
  return rings;
}

/**
 * Overall bbox of a ring list, in normalised mercator.
 *
 * @param {Ring[]} rings
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}}
 */
export function ringsBbox(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) {
    if (r.minX < minX) minX = r.minX;
    if (r.minY < minY) minY = r.minY;
    if (r.maxX > maxX) maxX = r.maxX;
    if (r.maxY > maxY) maxY = r.maxY;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Total vertex count, for diagnostics.
 *
 * @param {Ring[]} rings
 * @returns {number}
 */
export function countVertices(rings) {
  let n = 0;
  for (const r of rings) n += r.coords.length >> 1;
  return n;
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

function buildRing(lngLatRing) {
  const n = lngLatRing.length;
  if (n < 4) return null;

  // GeoJSON repeats the first vertex to close the ring; the renderer closes
  // paths itself, so drop the duplicate.
  const last = lngLatRing[n - 1];
  const first = lngLatRing[0];
  const closed = last[0] === first[0] && last[1] === first[1];
  const count = closed ? n - 1 : n;

  const coords = new Float64Array(count * 2);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let w = 0;
  for (let i = 0; i < count; i++) {
    const x = lngToMercatorX(lngLatRing[i][0]);
    const y = latToMercatorY(lngLatRing[i][1]);
    coords[w++] = x;
    coords[w++] = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (count < 3) return null;

  return {
    coords,
    minX,
    minY,
    maxX,
    maxY,
    size: Math.max(maxX - minX, maxY - minY),
  };
}

function eachPolygon(node, visit) {
  if (!node) return;
  switch (node.type) {
    case 'FeatureCollection':
      for (const f of node.features) eachPolygon(f, visit);
      break;
    case 'Feature':
      eachPolygon(node.geometry, visit);
      break;
    case 'GeometryCollection':
      for (const g of node.geometries) eachPolygon(g, visit);
      break;
    case 'Polygon':
      visit(node.coordinates);
      break;
    case 'MultiPolygon':
      for (const p of node.coordinates) visit(p);
      break;
    default:
      break;
  }
}
