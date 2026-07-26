/**
 * transform.js
 *
 * Recovers the affine transform that maps normalised Web Mercator to screen
 * pixels, from a MapLibre map or a deck.gl viewport.
 *
 * This is the hinge the whole design turns on. At pitch 0, a Web Mercator view
 * is *exactly* an affine transform of mercator space: scale by the world size,
 * rotate by the bearing, translate. So rather than projecting every coastline
 * vertex every frame - which is what makes naive canvas overlays stutter - we
 * hand six numbers to `ctx.setTransform` and let the rasteriser do it.
 *
 * The affine is recovered by probing: project the view centre and two small
 * offsets from it, then solve. That uses only public API (no `map.transform`),
 * costs three projections per frame, and picks up bearing for free.
 *
 * Pitch is the one case this cannot represent - a tilted view is projective,
 * not affine, and a 2D canvas has no perspective. With pitch the overlay
 * degrades to the tangent-plane approximation at the map centre, which is why
 * the examples pin `pitch: 0`.
 */

import {
  latToMercatorY,
  lngToMercatorX,
  mercatorXToLng,
  mercatorYToLat,
  worldSize,
} from '../core/mercator.js';

export { affineEquals, mercatorBounds } from '../render/bounds.js';

/**
 * @param {Object} map MapLibre GL / Mapbox GL map instance
 * @returns {import('../render/WaterlineRenderer.js').Affine}
 */
export function affineFromMap(map) {
  const centre = map.getCenter();
  return solve(
    centre.lng,
    centre.lat,
    map.getZoom(),
    (lng, lat) => {
      const p = map.project([lng, lat]);
      return [p.x, p.y];
    }
  );
}

/**
 * @param {Object} viewport deck.gl `WebMercatorViewport`
 * @returns {import('../render/WaterlineRenderer.js').Affine}
 */
export function affineFromViewport(viewport) {
  return solve(
    viewport.longitude,
    viewport.latitude,
    viewport.zoom,
    (lng, lat) => viewport.project([lng, lat])
  );
}

/**
 * Probe three points and solve for the affine.
 *
 * @param {number} lng centre longitude
 * @param {number} lat centre latitude
 * @param {number} zoom
 * @param {(lng:number, lat:number) => [number, number]} project
 * @returns {import('../render/WaterlineRenderer.js').Affine}
 */
export function solve(lng, lat, zoom, project) {
  const mx = lngToMercatorX(lng);
  const my = latToMercatorY(lat);

  // ~128 screen px expressed in mercator units: big enough to stay clear of
  // float noise, small enough that both probes stay on screen.
  const step = 128 / worldSize(zoom);
  // Flip the probe direction near the world edge so we never step across the
  // antimeridian or into the mercator latitude clamp.
  const dx = mx + step > 0.999 ? -step : step;
  const dy = my + step > 0.999 ? -step : step;

  const [x0, y0] = project(lng, lat);
  const [xx, xy] = project(mercatorXToLng(mx + dx), lat);
  const [yx, yy] = project(lng, mercatorYToLat(my + dy));

  const a = (xx - x0) / dx;
  const b = (xy - y0) / dx;
  const c = (yx - x0) / dy;
  const d = (yy - y0) / dy;

  return {
    a,
    b,
    c,
    d,
    e: x0 - a * mx - c * my,
    f: y0 - b * mx - d * my,
  };
}
