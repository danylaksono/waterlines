# Waterlines on interactive maps

**Waterlines** — also called _water lining_, _coastal vignetting_, or
_shore ripples_ — are the concentric lines engravers drew in the sea alongside
a coastline on nineteenth- and early twentieth-century charts. They emphasise
the shoreline, separate land from water at a glance, and give the sea a
texture. Drawn over a live MapLibre or deck.gl map, fast enough that the map still moves
at 60 fps.

The technique is [Olivia Vane's][notebook], from her Observable notebook
_Drawing waterlines on maps_. This repository takes it out of Observable and
makes it work on a map you can pan and zoom.

See it live here: [https://danylaksono.github.io/waterlines/studio](https://danylaksono.github.io/waterlines/studio/index.html)

![Waterlines over the Indonesian archipelago](docs/nusantara.png)

_"Kita adalah bangsa yang besar"_

## What is it for

I have always obsessed with old maps, and I wanted to make it easy to build an old-looking map on top of Maplibre/DeckGL's interactivity. The waterlines are a simple way to do that. They are also useful for emphasising the coastline in a map where the land and water are otherwise similar in colour.

You can use this for e.g., making an interactive storytelling historical map with emphasis on nautical stories, or for making a static map with a vintage look. I have some further ideas but I'll leave it for future development.

## Try it

```sh
npm start        # http://localhost:8080
```

| page                                                                     | what it is                                                             |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [`/studio`](studio/index.html)                                           | **Start here.** Drop in your own GeoJSON, style it, save a PNG.        |
| [`examples/indonesia-maplibre.html`](examples/indonesia-maplibre.html)   | Waterlines over Nusantara, with every style control and four basemaps. |
| [`examples/renderer-comparison.html`](examples/renderer-comparison.html) | The two renderers side by side on one view.                            |
| [`examples/indonesia-deckgl.html`](examples/indonesia-deckgl.html)       | The same thing driven by deck.gl.                                      |
| [`examples/still-gallery.html`](examples/still-gallery.html)             | No map — just geometry in a box, like the original notebook.           |

## Use it

No dependencies. MapLibre and deck.gl are optional, and only their own adapter
needs them.

### On a MapLibre map

```js
import { WaterlinesOverlay } from "./src/adapters/maplibre.js";

const overlay = new WaterlinesOverlay(map, {
  data: land, // any GeoJSON with polygons in it
  style: { preset: "antique" },
});

overlay.setStyle({ count: 18, extent: 60 }); // cheap — wire it to a slider
overlay.setVisible(false);
overlay.remove();
```

The overlay draws inside MapLibre's own render loop, so the ripples and the
basemap always arrive in the same frame.

### On a deck.gl viewport

```js
import { WaterlinesDeckOverlay } from "./src/adapters/deckgl.js";

const overlay = new WaterlinesDeckOverlay({ container, data: land });

// deck stops drawing when idle, so give the overlay its own frames.
const frame = () => {
  overlay.syncViewport(deckgl.getViewports()[0], { moving });
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
```

### With no map at all

```js
import { renderStill } from "./src/still.js";

document.body.append(
  renderStill(land, { width: 600, height: 600, style: { preset: "antique" } }),
);
```

## Style

Distances are in screen pixels, measured out from the shore, so the ripples
look the same however far you zoom.

| option            | default       | what it does                                                    |
| ----------------- | ------------- | --------------------------------------------------------------- |
| `count`           | `12`          | how many waterlines                                             |
| `extent`          | `34`          | how far the outermost one reaches                               |
| `inset`           | `2`           | how close the innermost one sits to the shore                   |
| `spacingExponent` | `0.7`         | below 1 crowds them against the shore, above 1 spreads them out |
| `lineWidth`       | `[0.9, 0.45]` | line thickness, `[innermost, outermost]`                        |
| `opacity`         | `[0.12, 1]`   | `[outermost, innermost]` — outer lines usually fade             |
| `color`           | `'#2f6f7e'`   | a colour, a list of colours, or `t => colour`                   |
| `filled`          | `false`       | solid bands instead of lines                                    |
| `land`            | `'clip'`      | `'clip'` lets the map show through, `'fill'` paints the land    |
| `coastline`       | `null`        | `{ color, width, opacity }` drawn on top                        |

Five presets to start from: `classic`, `antique`, `nautical`, `voronoi`,
`bands`. See the [gallery](examples/still-gallery.html).

If the ripples merge into one dark halo, you have asked for more lines than
`extent` has room for — raise `extent`, or lower `count`.

## Animation

Off by default. The ripples drift outward (or inward) on a loop:

```js
overlay.setAnimation({ periodMs: 1600, direction: "outwards" });
overlay.setAnimation(null); // stop
```

From [Vane's animation notebook][anim]. Each waterline slides out into the slot
the one ahead of it left; a new one is born at the shore and the outermost fades
away, so the loop never visibly jumps.

## Which renderer

There are two, and by default you get the better one automatically.

```js
new WaterlinesOverlay(map, { data: land, renderer: "auto" }); // the default
```

- **WebGL** measures how far every pixel is from the shore, then draws all the
  ripples in one go. Adding more lines costs nothing, and it stays sharp while
  you zoom.
- **Canvas** draws each ripple separately. Slower, but it runs anywhere, and it
  blends overlapping ripples in a way some people prefer.

`'auto'` uses WebGL when the browser supports it and quietly falls back to
canvas when it does not. Pass `'gl'` or `'2d'` to force one. See them together
at [`examples/renderer-comparison.html`](examples/renderer-comparison.html).

## The studio

[`/studio`](studio/index.html) is the fastest way to get a picture out of this.

Drop a GeoJSON anywhere on the page — polygons, multipolygons, coastlines,
lakes, building footprints, anything with an edge — and the ripples redraw
around it. Style it with the panel, then **Save PNG** for a finished image at up
to 3× screen resolution.

It also carries the chart furniture: an engraved wind rose you can place in any
corner, the criss-crossing rhumb lines of a portolan chart, and paper grain. On
the OpenHistoricalMap basemap a year slider appears over the map, so you can
watch the map itself change through history while the ripples stay put.

## Good to know

- **No tilt.** Bearing is fine, pitch is not — the overlay is flat by
  construction. The examples pin `pitch: 0`.
- **The waterlines sit above the map**, so basemap labels end up underneath
  them.
- **Your coastline and the basemap's may not be the same one.** They agree at a
  glance around zoom 4–9 and drift apart as you go closer. Feed the overlay the
  same geometry your basemap draws if that matters.
- **Very small islands are dropped** as you zoom out. `lod.minRingPx` decides
  where the cutoff is.

## More

[`docs/methodology.md`](docs/methodology.md) if you're interested on the
mathematics, the measurements, the things that did not work, and why the code
is shaped the way it is. I had some fun with trying out different ways to make this
work so this is where I put the notes.

```sh
npm test                 # unit tests
node scripts/smoke.mjs   # end-to-end browser check, with timings
```

## Credit

- Technique: [Olivia Vane, _Drawing waterlines on maps_][notebook], and her
  [animation notebook][anim].
- The compositing trick behind it:
  [Andy Woodruff, _Canvas cartography_](https://observablehq.com/@awoodruff/canvas-cartography-nacis-2019).
- Curve smoothing:
  [Nadieh Bremer, _Simplified curved earth map_](https://observablehq.com/@nbremer/simplified-curved-earth-map).
- Coastlines: [Natural Earth](https://www.naturalearthdata.com/), public domain.
- Woodblock basemap by [OpenHistoricalMap](https://github.com/OpenHistoricalMap/map-styles)
  (CC0), found via [pnorman/maplibre-styles](https://github.com/pnorman/maplibre-styles).

MIT — [@danylaksono](https://github.com/danylaksono)

[notebook]: https://observablehq.com/@oliviafvane/ii-drawing-waterlines-on-maps
[anim]: https://observablehq.com/@oliviafvane/iv-animating-waterlines-canvas-strokes
