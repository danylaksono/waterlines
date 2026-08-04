# Waterlines as a native MapLibre style (prototype)

A discussion prototype, kept separate from `../src`: instead of drawing
ripples on a 2D canvas every frame (`../src/render/WaterlineRenderer.js`),
this bakes the ripple *geometry* offline as real offset curves and renders
them as an ordinary MapLibre `line` layer. No canvas element, no per-frame
work, no `RasterCache`/`WaterlineEngine` adaptive-quality machinery - the
GPU just draws vector tiles the way it draws anything else.

It reuses the live renderer's spacing/colour math (`resolveStyle`, `powScale`
from `../src/render/style.js` and `../src/render/scales.js`) so a preset
produces the same ripple curve in both places; only the rendering technique
differs.

## Run it

```
npm start          # from the repo root - serves the whole repo, incl. this folder
```

then open `http://localhost:8080/maplibre-style/index.html`.

## Regenerate the data

```
cd maplibre-style
npm install                       # pulls in @turf/turf, dev-only, not shipped to the browser
node build-rings.mjs bali classic
node build-rings.mjs raja-ampat nautical
```

`build-rings.mjs`:

1. Loads a land polygon from `../data/*.geojson`.
2. Unions every polygon in it (`@turf/union`) so buffering merges nearby
   islands' ripples instead of leaving them overlapping - the `voronoi`
   preset's whole point.
3. For each ripple `i` in the preset, buffers outward by the preset's
   `offsetPx(i)` (same `powScale` curve the canvas renderer uses),
   converted to real metres at one reference latitude/zoom (see below), then
   takes the buffered polygon's boundary (`@turf/polygon-to-line`) as that
   ripple's geometry.
4. Writes every ripple as a `LineString`/`MultiLineString` feature tagged
   with `color`, `alpha`, and `width` - precomputed, so the style layer is
   just `['get', ...]` lookups, no runtime expressions.

`style.mjs` then wires that up: a `background` for the sea, a `fill` for the
land, a `line` layer reading `color`/`alpha`/`width` off the ring source, and
a `line` layer for the coast. `app.js` is a minimal viewer that swaps between
pre-generated region/preset combos with `map.setStyle`, same pattern as
`../shared/js/basemap.js`.

## What this buys you, and what it costs

**Cheaper at runtime.** No canvas compositing, no frame budget, no adaptive
resolution - it's vector tiles, same cost as any other line layer.

**Costs an offline pipeline instead.** Real polygon buffering on a detailed
coastline needs union/self-intersection handling - exactly what the canvas
renderer's stroke-and-erase trick was invented to dodge (see the comment at
the top of `WaterlineRenderer.js`). That cost doesn't disappear, it just
moves from "every frame" to "once, in `build-rings.mjs`" - a much better
place for it, but not free: `@turf/union` on a large coastline (Indonesia's
full extent, easily) will be slow enough that it deserves per-zoom tiling
(tippecanoe or similar) rather than one flat GeoJSON, which this prototype
doesn't attempt.

**Ring *positions* stop being screen-pixel-constant.** This is the
fundamental difference, not an implementation detail. `../src/render/style.js`
says outright: "Distances are in CSS pixels... measured from the shoreline
outwards" - the canvas renderer recomputes geometry per zoom level so a
ripple looks the same width no matter how far you're zoomed. Baked geometry
has a real size in metres; a `line-width` paint property is still screen
pixels (so individual strokes stay crisp), but the *spacing between* rings
now zooms with the map like any other geometry. `build-rings.mjs` picks one
`REFERENCE_ZOOM` (9) where a preset's pixel spacing and its baked metre
spacing agree; away from that zoom the two renderers visibly diverge -
zoom in and the baked rings spread out, zoom out and they crowd into a dark
smear. Try it in `index.html` to see it happen. Whether that's a bug or a
feature depends on what you want: true isobath-style behaviour (rings mean
a fixed real distance from shore, like nautical chart depth contours) versus
the notebook's original illustrative effect (rings always read the same at
any zoom).

**Live parameters become bake-time parameters.** `count`, `extent`, `inset`,
`spacingExponent` are runtime sliders in the canvas version
(`WaterlineEngine.setStyle`); here they're baked into the geometry, so
changing them means re-running `build-rings.mjs`, not moving a slider.
`color`/`width`/`opacity` stay adjustable as paint properties if you switch
them from precomputed `['get', ...]` lookups to zoom/property expressions,
but ring *count and position* are fixed at build time.

## Where this could go

- **Filled bands** (the `bands` preset): take the *difference* between two
  consecutive buffer distances instead of just the boundary line, to get
  solid annuli rather than strokes.
- **Per-zoom tilesets** instead of one flat GeoJSON, for regions too big to
  union/buffer in one pass (mirrors what `LodPyramid.js` does for the
  canvas renderer, but as an offline tiling step).
- **Other old-map devices as more native styles** - rhumb lines, wind roses,
  hachured relief - anything that's naturally "precompute geometry once,
  style with paint expressions" rather than "recompute every frame" is a
  candidate for living here rather than in `../src`. If this grows, it's a
  natural complement to the interactive studio (`../studio/index.html`):
  the studio's live sliders for one kind of exploration, prebaked styles
  like this for a more "finished chart" look, potentially picked from the
  same basemap-style switcher (`../shared/js/basemap.js`).
