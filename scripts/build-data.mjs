/**
 * build-data.mjs
 *
 * Reproducible data pipeline for the waterlines examples.
 *
 * Downloads Natural Earth land + minor-island polygons (public domain), clips
 * them to a region bounding box and writes a compact GeoJSON into `data/`.
 *
 * Usage:
 *   node scripts/build-data.mjs                 # build every region in REGIONS
 *   node scripts/build-data.mjs indonesia bali  # build named regions only
 *
 * Zero npm dependencies: the download, the bbox clip (Sutherland-Hodgman) and
 * the coordinate quantisation are all implemented here so the pipeline keeps
 * working years from now.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RAW_DIR = join(ROOT, 'data', '.raw');
const OUT_DIR = join(ROOT, 'data');

const NE_BASE =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

/** Natural Earth layers to merge, in draw order. */
const SOURCES = [
  { name: 'ne_10m_land', url: `${NE_BASE}/ne_10m_land.geojson` },
  { name: 'ne_10m_minor_islands', url: `${NE_BASE}/ne_10m_minor_islands.geojson` },
];

/**
 * Region presets. `bbox` is [west, south, east, north].
 *
 * Keep the bbox generously larger than the area you intend to look at: the clip
 * turns the bbox border into an artificial "coastline" that would otherwise
 * grow waterlines of its own.
 */
const REGIONS = {
  indonesia: {
    // Deliberately much wider than the demo's camera bounds. The clip turns
    // the bbox border into a dead-straight artificial coastline that would
    // grow waterlines of its own, so it is pushed off screen rather than
    // trimmed tight to the archipelago. It also brings in the neighbouring
    // coasts (Malaysia, PNG, the Philippines, northern Australia), which is
    // what you want anyway - islands do not stop at borders.
    bbox: [85.0, -22.0, 152.0, 16.0],
    // ~1 ha in square degrees; drops sandbars that are sub-pixel at any zoom
    // the demo uses, and Indonesia has thousands of them.
    minRingArea: 2e-7,
    precision: 5,
  },
  bali: {
    bbox: [113.5, -9.6, 117.5, -7.4],
    minRingArea: 1e-8,
    precision: 6,
  },
  'raja-ampat': {
    bbox: [129.0, -3.0, 132.5, 0.5],
    minRingArea: 1e-8,
    precision: 6,
  },
};

// --------------------------------------------------------------------------
// download (cached in data/.raw)
// --------------------------------------------------------------------------

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchCached(url, cachePath) {
  if (await exists(cachePath)) {
    console.log(`  cached  ${cachePath.replace(ROOT, '.')}`);
    return JSON.parse(await readFile(cachePath, 'utf8'));
  }
  console.log(`  fetch   ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const text = await res.text();
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, text);
  return JSON.parse(text);
}

// --------------------------------------------------------------------------
// geometry helpers
// --------------------------------------------------------------------------

/** Signed area * 2 of a ring, in square degrees. Sign encodes winding. */
function ringArea2(ring) {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a;
}

function ringBbox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function bboxIntersects(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function bboxInside(inner, outer) {
  return (
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[2] <= outer[2] &&
    inner[3] <= outer[3]
  );
}

/**
 * Clip a closed ring against one half-plane of the bbox (Sutherland-Hodgman).
 * `side` is one of 'w' | 'e' | 's' | 'n'.
 */
function clipHalfPlane(ring, side, bbox) {
  const [w, s, e, n] = bbox;
  const inside = {
    w: (p) => p[0] >= w,
    e: (p) => p[0] <= e,
    s: (p) => p[1] >= s,
    n: (p) => p[1] <= n,
  }[side];
  const intersect = {
    w: (a, b) => [w, a[1] + ((b[1] - a[1]) * (w - a[0])) / (b[0] - a[0])],
    e: (a, b) => [e, a[1] + ((b[1] - a[1]) * (e - a[0])) / (b[0] - a[0])],
    s: (a, b) => [a[0] + ((b[0] - a[0]) * (s - a[1])) / (b[1] - a[1]), s],
    n: (a, b) => [a[0] + ((b[0] - a[0]) * (n - a[1])) / (b[1] - a[1]), n],
  }[side];

  const out = [];
  for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
    const cur = ring[i];
    const prev = ring[j];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

/** Clip a ring to the bbox. Returns null if nothing survives. */
function clipRing(ring, bbox) {
  // Open the ring (GeoJSON repeats the first point) so the clipper does not
  // emit a duplicated vertex at the seam.
  let work = ring.slice(0, -1);
  for (const side of ['w', 'e', 's', 'n']) {
    work = clipHalfPlane(work, side, bbox);
    if (work.length < 3) return null;
  }
  work.push(work[0].slice());
  return work;
}

function quantiseRing(ring, precision) {
  const f = 10 ** precision;
  const out = [];
  let prevX = NaN;
  let prevY = NaN;
  for (const [x, y] of ring) {
    const qx = Math.round(x * f) / f;
    const qy = Math.round(y * f) / f;
    // Drop vertices that collapse onto their neighbour after rounding.
    if (qx === prevX && qy === prevY) continue;
    out.push([qx, qy]);
    prevX = qx;
    prevY = qy;
  }
  if (out.length < 3) return null;
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push(first.slice());
  return out.length >= 4 ? out : null;
}

/** Yield every Polygon coordinate array inside a GeoJSON geometry. */
function* eachPolygon(geometry) {
  if (!geometry) return;
  if (geometry.type === 'Polygon') {
    yield geometry.coordinates;
  } else if (geometry.type === 'MultiPolygon') {
    yield* geometry.coordinates;
  } else if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries) yield* eachPolygon(g);
  }
}

// --------------------------------------------------------------------------
// region build
// --------------------------------------------------------------------------

function buildRegion(collections, region) {
  const { bbox, minRingArea, precision } = region;
  const polygons = [];
  const stats = { polygonsIn: 0, polygonsOut: 0, ringsOut: 0, verticesOut: 0 };

  for (const fc of collections) {
    for (const feature of fc.features) {
      for (const poly of eachPolygon(feature.geometry)) {
        stats.polygonsIn++;
        const outerBbox = ringBbox(poly[0]);
        if (!bboxIntersects(outerBbox, bbox)) continue;

        const needsClip = !bboxInside(outerBbox, bbox);
        const rings = [];
        for (let r = 0; r < poly.length; r++) {
          let ring = poly[r];
          if (needsClip) {
            ring = clipRing(ring, bbox);
            if (!ring) {
              // An outer ring that vanishes kills the whole polygon; a hole
              // that vanishes just means the hole is outside the view.
              if (r === 0) { rings.length = 0; break; }
              continue;
            }
          }
          ring = quantiseRing(ring, precision);
          if (!ring) {
            if (r === 0) { rings.length = 0; break; }
            continue;
          }
          if (Math.abs(ringArea2(ring)) / 2 < minRingArea) {
            if (r === 0) { rings.length = 0; break; }
            continue;
          }
          rings.push(ring);
        }

        if (!rings.length) continue;
        polygons.push(rings);
        stats.polygonsOut++;
        stats.ringsOut += rings.length;
        for (const ring of rings) stats.verticesOut += ring.length;
      }
    }
  }

  // One MultiPolygon feature: the renderer flattens to rings anyway, and a
  // single feature keeps the file small and MapLibre-source friendly.
  return {
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { source: 'Natural Earth 10m (public domain)' },
          geometry: { type: 'MultiPolygon', coordinates: polygons },
        },
      ],
      bbox,
    },
    stats,
  };
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  const requested = process.argv.slice(2);
  const names = requested.length ? requested : Object.keys(REGIONS);

  for (const name of names) {
    if (!REGIONS[name]) {
      throw new Error(
        `Unknown region "${name}". Known: ${Object.keys(REGIONS).join(', ')}`
      );
    }
  }

  console.log('Sources:');
  const collections = [];
  for (const src of SOURCES) {
    collections.push(await fetchCached(src.url, join(RAW_DIR, `${src.name}.geojson`)));
  }

  await mkdir(OUT_DIR, { recursive: true });
  for (const name of names) {
    const { geojson, stats } = buildRegion(collections, REGIONS[name]);
    const outPath = join(OUT_DIR, `${name}-land.geojson`);
    const text = JSON.stringify(geojson);
    await writeFile(outPath, text);
    console.log(
      `${name}: ${stats.polygonsOut}/${stats.polygonsIn} polygons, ` +
        `${stats.ringsOut} rings, ${stats.verticesOut} vertices, ` +
        `${(text.length / 1024).toFixed(0)} kB -> ${outPath.replace(ROOT, '.')}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
