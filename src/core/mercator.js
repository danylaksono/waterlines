/**
 * mercator.js
 *
 * Web-Mercator helpers.
 *
 * Everything upstream of the renderer works in *normalised* Web Mercator:
 * x and y both run 0..1 over the square world, x=0 at 180degW, y=0 at the
 * north edge (~85.051degN). This is the same space MapLibre's
 * `MercatorCoordinate` uses, which is what lets the overlay be synchronised
 * with the map by a plain affine transform instead of per-vertex projection.
 */

/** Nominal tile size, i.e. world pixels at zoom 0. */
export const TILE_SIZE = 512;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Latitude limit of the Web Mercator square. */
export const MAX_LATITUDE = 85.051128779806604;

/**
 * @param {number} lng degrees
 * @returns {number} normalised mercator x in [0, 1]
 */
export function lngToMercatorX(lng) {
  return (180 + lng) / 360;
}

/**
 * @param {number} lat degrees
 * @returns {number} normalised mercator y in [0, 1]
 */
export function latToMercatorY(lat) {
  const clamped = lat > MAX_LATITUDE ? MAX_LATITUDE : lat < -MAX_LATITUDE ? -MAX_LATITUDE : lat;
  return (
    (180 - R2D * Math.log(Math.tan(Math.PI / 4 + (clamped * D2R) / 2))) / 360
  );
}

/**
 * @param {number} x normalised mercator x
 * @returns {number} longitude in degrees
 */
export function mercatorXToLng(x) {
  return x * 360 - 180;
}

/**
 * @param {number} y normalised mercator y
 * @returns {number} latitude in degrees
 */
export function mercatorYToLat(y) {
  const y2 = 180 - y * 360;
  return R2D * (2 * Math.atan(Math.exp(y2 * D2R)) - Math.PI / 2);
}

/**
 * World size in pixels at a given zoom, i.e. how many screen pixels one unit
 * of normalised mercator spans.
 *
 * @param {number} zoom
 * @returns {number}
 */
export function worldSize(zoom) {
  return TILE_SIZE * Math.pow(2, zoom);
}

/**
 * Metres per normalised-mercator unit at a given latitude. Used when a style
 * asks for waterline spacing in ground units rather than screen pixels.
 *
 * @param {number} lat degrees
 * @returns {number}
 */
export function metersPerMercatorUnit(lat) {
  const EARTH_CIRCUMFERENCE = 40075016.686;
  return EARTH_CIRCUMFERENCE * Math.cos(lat * D2R);
}
