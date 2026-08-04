/**
 * geojson-input.js
 *
 * Loading a user's own GeoJSON: file picker, drag-and-drop, or URL.
 *
 * Validation is done by running the file through the same `geojsonToRings`
 * the renderer uses, so "will this draw anything?" is answered by the actual
 * parser rather than by a guess about the schema. A file with no polygon rings
 * is rejected up front instead of rendering as a blank overlay.
 */

import { geojsonToRings, ringsBbox } from '../../src/core/rings.js';
import { mercatorXToLng, mercatorYToLat } from '../../src/core/mercator.js';

/**
 * @typedef {Object} LoadedData
 * @property {Object} geojson
 * @property {number} rings
 * @property {number} vertices
 * @property {[[number, number], [number, number]]} bounds [[w, s], [e, n]]
 * @property {string} name
 */

/**
 * Parse and validate GeoJSON text.
 *
 * @param {string} text
 * @param {string} name for messages
 * @returns {LoadedData}
 */
export function parseGeoJson(text, name = 'data') {
  let geojson;
  try {
    geojson = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not valid JSON (${error.message})`);
  }
  if (!geojson || typeof geojson !== 'object') {
    throw new Error(`${name} is not a GeoJSON object`);
  }

  const rings = geojsonToRings(geojson);
  if (!rings.length) {
    throw new Error(
      `${name} has no polygons. Waterlines need areas to draw around - ` +
        'points and lines cannot grow a shoreline.'
    );
  }

  let vertices = 0;
  for (const ring of rings) vertices += ring.coords.length >> 1;

  const bbox = ringsBbox(rings);
  return {
    geojson,
    rings: rings.length,
    vertices,
    // Mercator y grows southwards, so maxY is the southern edge.
    bounds: [
      [mercatorXToLng(bbox.minX), mercatorYToLat(bbox.maxY)],
      [mercatorXToLng(bbox.maxX), mercatorYToLat(bbox.minY)],
    ],
    name,
  };
}

/**
 * @param {File} file
 * @returns {Promise<LoadedData>}
 */
export async function readGeoJsonFile(file) {
  if (file.size > 64 * 1024 * 1024) {
    throw new Error(`${file.name} is over 64 MB - simplify it first`);
  }
  return parseGeoJson(await file.text(), file.name);
}

/**
 * @param {string} url
 * @returns {Promise<LoadedData>}
 */
export async function fetchGeoJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }
  return parseGeoJson(await response.text(), url.split('/').pop() || url);
}

/**
 * Make an element accept dropped files.
 *
 * @param {HTMLElement} element
 * @param {(file: File) => void} onFile
 * @param {(active: boolean) => void} [onHover] toggle a drop-target style
 * @returns {() => void} detach
 */
export function attachDropZone(element, onFile, onHover) {
  let depth = 0;

  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const enter = (event) => {
    stop(event);
    depth++;
    if (onHover) onHover(true);
  };
  const leave = (event) => {
    stop(event);
    depth = Math.max(0, depth - 1);
    if (!depth && onHover) onHover(false);
  };
  const drop = (event) => {
    stop(event);
    depth = 0;
    if (onHover) onHover(false);
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) onFile(file);
  };

  element.addEventListener('dragenter', enter);
  element.addEventListener('dragover', stop);
  element.addEventListener('dragleave', leave);
  element.addEventListener('drop', drop);

  return () => {
    element.removeEventListener('dragenter', enter);
    element.removeEventListener('dragover', stop);
    element.removeEventListener('dragleave', leave);
    element.removeEventListener('drop', drop);
  };
}
