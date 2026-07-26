/**
 * run-tests.mjs
 *
 * Unit tests for the parts that are pure maths and therefore checkable without
 * a browser: mercator, simplification, curve generation, scales, and the
 * affine solve/invert pair. `node --test tests/run-tests.mjs`, or `npm test`.
 *
 * The rendering itself is verified in a real browser by
 * `scripts/smoke-browser.mjs`, since it depends on canvas compositing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  latToMercatorY,
  lngToMercatorX,
  mercatorXToLng,
  mercatorYToLat,
  worldSize,
} from '../src/core/mercator.js';
import { countVertices, geojsonToRings, ringsBbox } from '../src/core/rings.js';
import { simplifyRing } from '../src/core/simplify.js';
import { appendRingToPath } from '../src/core/path.js';
import { powScale } from '../src/render/scales.js';
import { mercatorBounds } from '../src/render/bounds.js';
import { solve } from '../src/adapters/transform.js';

// --------------------------------------------------------------------------

test('mercator round-trips', () => {
  for (const lng of [-180, -117.2, 0, 106.8, 180]) {
    assert.ok(Math.abs(mercatorXToLng(lngToMercatorX(lng)) - lng) < 1e-9);
  }
  for (const lat of [-84, -8.65, 0, 6.2, 84]) {
    assert.ok(Math.abs(mercatorYToLat(latToMercatorY(lat)) - lat) < 1e-9);
  }
  assert.equal(lngToMercatorX(-180), 0);
  assert.equal(lngToMercatorX(180), 1);
  assert.ok(Math.abs(latToMercatorY(0) - 0.5) < 1e-12);
  assert.equal(worldSize(0), 512);
  assert.equal(worldSize(4), 8192);
});

test('mercator clamps beyond the square', () => {
  // The clamp latitude is exactly the top and bottom edge of the square.
  assert.ok(Math.abs(latToMercatorY(89)) < 1e-12);
  assert.ok(Math.abs(latToMercatorY(-89) - 1) < 1e-12);
  assert.equal(latToMercatorY(89), latToMercatorY(85.051128779806604));
});

// --------------------------------------------------------------------------

test('geojsonToRings drops the repeated closing vertex and keeps a bbox', () => {
  const square = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[[100, 0], [101, 0], [101, 1], [100, 1], [100, 0]]],
    },
  };
  const rings = geojsonToRings(square);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].coords.length, 8, 'four vertices, interleaved');
  assert.equal(countVertices(rings), 4);

  const bbox = ringsBbox(rings);
  assert.ok(Math.abs(bbox.minX - lngToMercatorX(100)) < 1e-12);
  assert.ok(Math.abs(bbox.maxX - lngToMercatorX(101)) < 1e-12);
  // Mercator y grows southwards, so lat 1 is the *smaller* y.
  assert.ok(Math.abs(bbox.minY - latToMercatorY(1)) < 1e-12);
  assert.ok(Math.abs(bbox.maxY - latToMercatorY(0)) < 1e-12);
});

test('geojsonToRings walks MultiPolygon and holes', () => {
  const data = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]],
              [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]],
            ],
            [[[5, 5], [6, 5], [6, 6], [5, 5]]],
          ],
        },
      },
    ],
  };
  assert.equal(geojsonToRings(data).length, 3, 'outer + hole + second polygon');
});

// --------------------------------------------------------------------------

test('simplifyRing removes collinear detail but keeps the corners', () => {
  // A square whose edges are subdivided into many collinear points.
  const pts = [];
  const corners = [[0, 0], [10, 0], [10, 10], [0, 10]];
  for (let c = 0; c < 4; c++) {
    const [ax, ay] = corners[c];
    const [bx, by] = corners[(c + 1) % 4];
    for (let i = 0; i < 25; i++) {
      pts.push(ax + ((bx - ax) * i) / 25, ay + ((by - ay) * i) / 25);
    }
  }
  const coords = Float64Array.from(pts);
  const out = simplifyRing(coords, 0.01);
  assert.equal(out.length / 2, 4, 'collapses to the four corners');
});

test('simplifyRing keeps a circle recognisable and never degenerates', () => {
  const n = 512;
  const coords = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    coords[i * 2] = Math.cos(a);
    coords[i * 2 + 1] = Math.sin(a);
  }
  const out = simplifyRing(coords, 0.01);
  assert.ok(out.length / 2 < n, 'did simplify');
  assert.ok(out.length / 2 > 8, 'did not collapse the ring');
  for (let i = 0; i < out.length; i += 2) {
    const r = Math.hypot(out[i], out[i + 1]);
    assert.ok(Math.abs(r - 1) < 1e-9, 'kept vertices lie on the original ring');
  }
});

test('simplifyRing is a no-op below four vertices or zero tolerance', () => {
  const tri = Float64Array.from([0, 0, 1, 0, 0, 1]);
  assert.equal(simplifyRing(tri, 1), tri);
  const quad = Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 1.5]);
  assert.equal(simplifyRing(quad, 0), quad);
});

// --------------------------------------------------------------------------

class RecordingPath {
  constructor() {
    this.ops = [];
    this.points = [];
  }
  moveTo(x, y) { this.ops.push('M'); this.points.push([x, y]); }
  lineTo(x, y) { this.ops.push('L'); this.points.push([x, y]); }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    this.ops.push('C');
    this.points.push([c1x, c1y], [c2x, c2y], [x, y]);
  }
  closePath() { this.ops.push('Z'); }
}

function circleRing(n, radius = 1, cx = 0, cy = 0) {
  const coords = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    coords[i * 2] = cx + radius * Math.cos(a);
    coords[i * 2 + 1] = cy + radius * Math.sin(a);
  }
  return coords;
}

test('catmull-rom emits one cubic per edge when not flattening', () => {
  const n = 12;
  const path = new RecordingPath();
  appendRingToPath(path, circleRing(n, 0.1, 0.5, 0.5), 1000, { flatten: false });

  assert.equal(path.ops[0], 'M');
  assert.equal(path.ops.filter((o) => o === 'C').length, n);
  assert.equal(path.ops[path.ops.length - 1], 'Z');
});

test('catmull-rom control points stay near the curve for a circle', () => {
  const path = new RecordingPath();
  appendRingToPath(path, circleRing(24), 1, { flatten: false });
  for (const [x, y] of path.points) {
    const r = Math.hypot(x, y);
    // Control points sit just outside the polygon but well inside 1 + 1/n.
    assert.ok(r > 0.95 && r < 1.08, `control radius ${r}`);
  }
});

test('flattening is the default and emits only line segments', () => {
  const path = new RecordingPath();
  appendRingToPath(path, circleRing(24, 200), 1, { flatness: 0.75 });

  assert.equal(path.ops[0], 'M');
  assert.equal(path.ops.filter((o) => o === 'C').length, 0, 'no cubics survive');
  assert.ok(path.ops.filter((o) => o === 'L').length >= 24, 'at least one line per edge');
  assert.equal(path.ops[path.ops.length - 1], 'Z');
});

test('flattened points stay within tolerance of the smooth curve', () => {
  // A circle of radius 200: the centripetal Catmull-Rom through 32 samples is
  // very close to the circle, so every flattened vertex should be too.
  const flatness = 0.75;
  const path = new RecordingPath();
  appendRingToPath(path, circleRing(32, 200), 1, { flatness });

  let worst = 0;
  for (const [x, y] of path.points) {
    worst = Math.max(worst, Math.abs(Math.hypot(x, y) - 200));
  }
  assert.ok(worst < flatness + 0.5, `worst deviation ${worst.toFixed(3)} px`);
});

test('coarser flattening produces fewer segments', () => {
  const fine = new RecordingPath();
  const coarse = new RecordingPath();
  appendRingToPath(fine, circleRing(32, 400), 1, { flatness: 0.2 });
  appendRingToPath(coarse, circleRing(32, 400), 1, { flatness: 4 });
  assert.ok(
    coarse.ops.length < fine.ops.length,
    `${coarse.ops.length} should be fewer than ${fine.ops.length}`
  );
});

test('linear curve emits plain line segments', () => {
  const coords = Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1]);
  const path = new RecordingPath();
  appendRingToPath(path, coords, 2, { curve: 'linear' });
  assert.deepEqual(path.ops, ['M', 'L', 'L', 'L', 'Z']);
  assert.deepEqual(path.points[1], [2, 0], 'scale is applied');
});

// --------------------------------------------------------------------------

test('powScale matches d3.scalePow semantics', () => {
  const linear = powScale([0, 10], [0, 100], 1);
  assert.equal(linear(0), 0);
  assert.equal(linear(5), 50);
  assert.equal(linear(10), 100);

  // exponent 2 over domain [0, n]: y = r0 + (r1 - r0) * (x / n) ** 2
  const squared = powScale([0, 4], [0, 16], 2);
  assert.ok(Math.abs(squared(2) - 4) < 1e-12);

  // The waterline spacing scale: decreasing range, sub-linear exponent.
  const pen = powScale([0, 10], [80, 4], 0.5);
  assert.equal(pen(0), 80);
  assert.ok(Math.abs(pen(10) - 4) < 1e-12);
  assert.ok(pen(5) < 80 && pen(5) > 4);
  assert.ok(pen(5) < 42, 'sub-linear exponent crowds lines toward the shore');
});

test('powScale survives a zero-width domain', () => {
  const flat = powScale([3, 3], [1, 9], 1);
  assert.equal(flat(3), 1);
});

// --------------------------------------------------------------------------

test('solve recovers a known scale/translate transform', () => {
  const zoom = 6;
  const scale = worldSize(zoom);
  const project = (lng, lat) => [
    lngToMercatorX(lng) * scale + 17,
    latToMercatorY(lat) * scale - 42,
  ];
  const m = solve(117.8, -2.2, zoom, project);

  assert.ok(Math.abs(m.a - scale) < 1e-6);
  assert.ok(Math.abs(m.d - scale) < 1e-6);
  assert.ok(Math.abs(m.b) < 1e-6);
  assert.ok(Math.abs(m.c) < 1e-6);
  assert.ok(Math.abs(m.e - 17) < 1e-6);
  assert.ok(Math.abs(m.f + 42) < 1e-6);
});

test('solve recovers a rotated transform', () => {
  const zoom = 8;
  const scale = worldSize(zoom);
  const theta = (30 * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const project = (lng, lat) => {
    const x = lngToMercatorX(lng) * scale;
    const y = latToMercatorY(lat) * scale;
    return [x * cos - y * sin + 5, x * sin + y * cos + 9];
  };
  const m = solve(115.75, -8.5, zoom, project);

  assert.ok(Math.abs(m.a - scale * cos) < 1e-4);
  assert.ok(Math.abs(m.b - scale * sin) < 1e-4);
  assert.ok(Math.abs(m.c + scale * sin) < 1e-4);
  assert.ok(Math.abs(m.d - scale * cos) < 1e-4);
  // Uniform scale is recovered even though the axes are rotated.
  assert.ok(Math.abs(Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) - scale) < 1e-3);
});

test('mercatorBounds inverts the transform, padding included', () => {
  const scale = worldSize(5);
  const m = { a: scale, b: 0, c: 0, d: scale, e: -1000, f: -500 };
  const b = mercatorBounds(m, 800, 600, 0);

  assert.ok(Math.abs(b.minX - 1000 / scale) < 1e-12);
  assert.ok(Math.abs(b.maxX - 1800 / scale) < 1e-12);
  assert.ok(Math.abs(b.minY - 500 / scale) < 1e-12);
  assert.ok(Math.abs(b.maxY - 1100 / scale) < 1e-12);

  const padded = mercatorBounds(m, 800, 600, 64);
  assert.ok(Math.abs((padded.minX - b.minX) * scale + 64) < 1e-9);
  assert.ok(Math.abs((padded.maxX - b.maxX) * scale - 64) < 1e-9);
});

test('mercatorBounds covers the whole rotated viewport', () => {
  const scale = worldSize(7);
  const theta = Math.PI / 4;
  const m = {
    a: scale * Math.cos(theta),
    b: scale * Math.sin(theta),
    c: -scale * Math.sin(theta),
    d: scale * Math.cos(theta),
    e: 100,
    f: 100,
  };
  const b = mercatorBounds(m, 400, 400, 0);
  // Every screen corner must map inside the reported bbox.
  for (const [sx, sy] of [[0, 0], [400, 0], [400, 400], [0, 400]]) {
    const det = m.a * m.d - m.c * m.b;
    const qx = sx - m.e;
    const qy = sy - m.f;
    const u = (m.d * qx - m.c * qy) / det;
    const v = (-m.b * qx + m.a * qy) / det;
    assert.ok(u >= b.minX - 1e-12 && u <= b.maxX + 1e-12);
    assert.ok(v >= b.minY - 1e-12 && v <= b.maxY + 1e-12);
  }
});
