/**
 * build-rings.mjs
 *
 * Bakes the waterline ripple *geometry* offline, instead of drawing it on a
 * canvas every frame.
 *
 * ../src/render/WaterlineRenderer.js strokes one coastline path N times and
 * erases part of each stroke, because computing N real offset curves per
 * frame is too slow. Here that constraint is gone - this runs once, not once
 * a frame - so it computes real offsets with turf's polygon buffering and
 * writes them out as plain LineString features, one per ripple, tagged with
 * enough properties for a MapLibre style to reproduce the fade.
 *
 * It deliberately reuses the *same* spacing math as the live renderer
 * (`resolveStyle`, `powScale`) so a given preset produces the same ripple
 * curve in both places - only the rendering technique differs.
 *
 * Usage:
 *   node build-rings.mjs [region] [preset]
 *   node build-rings.mjs bali classic
 *   node build-rings.mjs raja-ampat nautical
 *
 * Output: data/<region>-<preset>-rings.geojson
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buffer } from '@turf/buffer';
import { union } from '@turf/union';
import { polygonToLine } from '@turf/polygon-to-line';
import { featureCollection } from '@turf/helpers';

import { resolveStyle, colorAccessor } from '../src/render/style.js';
import { powScale } from '../src/render/scales.js';
import { metersPerMercatorUnit, worldSize } from '../src/core/mercator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(__dirname, 'data');

const REGIONS = {
  bali: { data: join(ROOT, 'data', 'bali-land.geojson') },
  'raja-ampat': { data: join(ROOT, 'data', 'raja-ampat-land.geojson') },
  indonesia: { data: join(ROOT, 'data', 'indonesia-land.geojson') },
};

// The canvas renderer's distances are CSS px and stay constant on screen at
// every zoom (it re-renders per zoom level). Baked geometry can't do that -
// once it's a real offset curve, it has a real size in metres. This picks
// the zoom/latitude at which "extent px" and "extent metres" agree, so the
// two renderers can be compared like for like *at that one zoom*; zoom away
// from it and the baked rings will over- or under-shoot the canvas version's
// spacing, which is the whole point of comparing them.
const REFERENCE_ZOOM = 9;

async function main() {
  const [regionArg, presetArg] = process.argv.slice(2);
  const region = regionArg || 'bali';
  const preset = presetArg || 'classic';

  const config = REGIONS[region];
  if (!config) {
    throw new Error(`Unknown region "${region}". Known: ${Object.keys(REGIONS).join(', ')}`);
  }

  console.log(`region=${region} preset=${preset} referenceZoom=${REFERENCE_ZOOM}`);

  const land = JSON.parse(await readFile(config.data, 'utf8'));
  const style = resolveStyle({ preset });
  const lat = centroidLatitude(land);
  const metersPerPixel = metersPerMercatorUnit(lat) / worldSize(REFERENCE_ZOOM);

  console.log(`  centroid latitude ~${lat.toFixed(2)}deg -> ${metersPerPixel.toFixed(1)} m/px`);

  const n = Math.max(1, Math.round(style.count));
  const offsetPx = powScale([0, n], [style.extent, style.inset], style.spacingExponent);
  const widthPx = powScale([0, n], [style.lineWidth[1], style.lineWidth[0]], 3);
  const alphaAt = powScale([0, n], style.opacity, style.opacityExponent);
  const colorAt = colorAccessor(style.color);

  console.log(`  dissolving ${countPolygons(land)} land polygon(s) before buffering`);
  const merged = dissolveAll(land);

  const features = [];
  for (let i = 0; i <= n; i++) {
    const t = 1 - i / n; // 0 = innermost, 1 = outermost - matches style.js's colour convention
    const distanceKm = (offsetPx(i) * metersPerPixel) / 1000;

    const buffered = buffer(merged, distanceKm, { units: 'kilometers' });
    const line = polygonToLine(buffered);
    const lineFeatures = line.type === 'FeatureCollection' ? line.features : [line];

    for (const feature of lineFeatures) {
      features.push({
        type: 'Feature',
        geometry: feature.geometry,
        properties: {
          i,
          t,
          color: colorAt(t),
          alpha: alphaAt(i),
          width: widthPx(i),
        },
      });
    }
    console.log(
      `  ring ${i}/${n}: ${distanceKm.toFixed(3)} km offset, width ${widthPx(i).toFixed(2)}px, alpha ${alphaAt(i).toFixed(2)}`
    );
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${region}-${preset}-rings.geojson`);
  await writeFile(outPath, JSON.stringify(featureCollection(features)));
  console.log(`  wrote ${features.length} ring features -> ${outPath.replace(ROOT, '.')}`);
}

/** Union every polygon in a FeatureCollection into one (multi)polygon, so
 * buffering merges nearby islands' ripples instead of leaving them
 * overlapping (the "voronoi" preset's whole point). */
function dissolveAll(geojson) {
  const polys = (geojson.features || [geojson]).filter(
    (f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
  );
  if (polys.length === 0) throw new Error('No polygon features to buffer');
  if (polys.length === 1) return polys[0];
  return union(featureCollection(polys));
}

function countPolygons(geojson) {
  return (geojson.features || [geojson]).length;
}

function centroidLatitude(geojson) {
  let sum = 0;
  let count = 0;
  const visit = (coords, depth) => {
    if (depth === 0) {
      sum += coords[1];
      count++;
      return;
    }
    for (const c of coords) visit(c, depth - 1);
  };
  for (const feature of geojson.features || [geojson]) {
    const g = feature.geometry;
    if (!g) continue;
    const depth = g.type === 'Polygon' ? 2 : g.type === 'MultiPolygon' ? 3 : -1;
    if (depth < 0) continue;
    visit(g.coordinates, depth);
  }
  return count ? sum / count : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
