# Waterlines — 10-slide carousel

Draft copy for an educational Instagram carousel aimed at the compsci and
geoinformatics communities. Companion piece to [`methodology.md`](methodology.md),
which is the source for every number quoted here.

**Format:** 4:5 (1080 × 1350) for feed real estate. Keep on-image text to ≤ 25
words per slide; everything else goes in the caption. One idea per slide.

**Credit placement:** Olivia Vane is credited on slide 2, not slide 10. The
technique is hers, and most viewers never swipe to the end — a credit that only
appears there reads as if we invented it.

**Slides most worth the design time:** 4 (the trick), 6 (the Voronoi payoff),
9 (the 99 → 16.6 ms bar). Those are what get saved and reshared; the rest is
connective tissue.

---

## 1 — Title / hook

**Visual:** `docs/nusantara.png`, full bleed, minimal text.

> Old maps drew these ripples around every coastline. By hand.
>
> Here they are on a map you can drag — at 60 fps.

Don't explain anything. The image is the hook.

---

## 2 — What you're looking at

**Visual:** side-by-side of a real 19th-century engraved chart and our render.

> **Waterlines.** Not depth. Not data. A graphic device to make land pop off
> the page.

**Caption beats**

- Also called *water lining*, *coastal vignetting*, or *shore ripples*.
- Standard in 19th- and early 20th-century engraving.
- They encode **nothing** — the spacing is purely aesthetic. That turns out to
  matter later: it is why everything lives in screen pixels rather than metres.
- Credit: the technique is Olivia Vane's, from her Observable notebook
  *Drawing waterlines on maps*.

---

## 3 — The obvious way, and why it's a trap

**Visual:** one coastline with 12 offset curves, self-intersections circled.

> Draw the coast 12 times, each a bit further out.
>
> `turf.buffer` × 12 ≈ **40 seconds**. For one still image.

**Caption beats**

- These are *offset curves*.
- They self-intersect wherever the offset exceeds the local radius of curvature.
- Their topology changes with distance — two islands' rings merge into one.
- Cleaning that up is the entire cost.

---

## 4 — The trick ⭐

**Visual:** three panels — fat stroke → erase narrower stroke → the ring that
remains. This is the best diagram in the set; give it the most design effort.

> Draw a **very fat line** on the coast. Erase a slightly thinner one from its
> middle.
>
> What's left is a ring at an exact distance. Free.

**Caption beats**

- Stroking with a pen of width *w* paints everything within *w*/2 of the path —
  that is the definition of a stroke.
- So fat minus thin is an annular band at a known distance.
- `globalCompositeOperation = 'destination-out'` does the subtraction.
- No offset curve is ever constructed; the rasteriser resolves the
  self-intersections for free with its fill rule.
- Repeat with a narrowing pen and the rings nest inside each other.

Include the eight-line loop from the README verbatim. People screenshot code.

---

## 5 — Two rules you can't break

**Visual:** left, a half-finished render (broken); right, an unsmoothed
coastline erupting in spikes next to the smoothed version. Both already exist
in the still gallery.

> **Order is fixed.** Each pass erases inside the last. A half-done render isn't
> a picture.
>
> **Smooth first.** A wide pen turns every sharp vertex into a spike.

**Caption beats**

- Outward-in, always.
- Smoothing is centripetal Catmull–Rom (α = ½) — the only parameterisation in
  that family proven to produce no cusps and no self-intersections within a
  segment (Yuksel, Schaefer & Keyser, 2011).
- Under a 90-pixel pen that guarantee is load-bearing, not cosmetic.

---

## 6 — The accidental beauty

**Visual:** `docs/komodo.png`, zoomed into the water between two islands, with
the Voronoi-ish partition traced faintly over it.

> Between close islands the ripples resolve into cells.
>
> That's not an artefact — it's the **medial axis** becoming visible.

**Caption beats**

- Where the offset curve *would have* self-intersected is exactly the medial
  axis of the water.
- Between two islands, that is an edge of their generalised Voronoi diagram.
- The thing that made the naive method hard is the thing that makes this one
  beautiful.
- Blum (1967), Aurenhammer (1991) if anyone wants to dig.

The most shareable slide in the set.

---

## 7 — Now make it move

**Visual:** the band of painted pixels highlighted along the whole
archipelago's coast, with a pixel counter.

> A still image can afford one slow render. A map can't.
>
> The cost isn't the geometry — it's **painted area**. Tens of millions of
> pixels. Per frame.

**Caption beats**

- Each pass paints a band 2 × the extent wide along every visible coast, twice.
- There are 12–14 passes.
- No amount of vertex optimisation touches it.

This is where the post pivots from cartography to systems.

---

## 8 — Never project per frame

**Visual:** the six-number affine matrix, big, with an arrow from
"60,000 vertices" to "6 numbers".

> At pitch 0, Web Mercator → screen is **exactly affine**.
>
> So project once. Then a frame is six numbers. JavaScript never touches a
> vertex.

**Caption beats**

- `ctx.setTransform` takes exactly those six numbers.
- Recover them from three `map.project` calls — no private map internals, and
  bearing comes for free.
- The catch: a tilted view is *projective*, not affine, and a 2D canvas has no
  perspective divide. Pitch isn't unimplemented here — it's impossible.

---

## 9 — Two lessons that cost me real time

**Visual:** the before/after bar — 99.4 ms vs 16.6 ms — as the dominant element.

> **You cannot time canvas drawing.** It reported 0.1 ms for frames taking
> 100 ms.
>
> **Pacing isn't enough — you have to yield.**

**Caption beats**

- A 2D canvas records commands and rasterises later, so a stopwatch around
  `stroke()` measures nothing.
- Forcing a flush with `getImageData` makes it honest *and* costs more than the
  work being measured.
- Pace on observed frame intervals instead — no readback needed.
- The structural one: one pass over a continental coastline costs ~130 ms, and
  one pass is the smallest unit that leaves the image valid. **No step count
  fits 130 ms into 16.6 ms.**
- So while you're dragging, the refresh stops dead and a cached bitmap is
  blitted; it resumes when you let go.
- Median frame interval while dragging during a refresh: **99.4 ms → 16.6 ms**.
  That one change is the whole post's payoff.

---

## 10 — Result, and go play with it

**Visual:** the results table, clean, plus a small grid of the five presets.

> 712 islands. 60 fps at every zoom. Even mid-refresh.
>
> Zero runtime dependencies. MIT.

**Caption beats**

- 16.4 ms median with the overlay off, 16.7 ms with it on.
- The honest caveat: 0.3 s to draft, up to ~4 s to fully sharpen at continental
  zoom — it just never blocks you.
- Repo link; `examples/studio.html` for dropping in your own GeoJSON.
- Credits in full: Olivia Vane (technique), Andy Woodruff (the compositing
  groundwork), Nadieh Bremer (smoothing), Natural Earth (coastlines, public
  domain).

---

## Alternate slide

Slide 5 could instead become the **spacing design rule**:

$$N \le \frac{k\,(E - s)}{\delta}$$

with a good-versus-fused-halo comparison. It is the one piece of original
cartographic thinking in the project, it is immediately actionable, and there is
a real failure case behind it — an earlier version shipped `count: 22` at
`extent: 34`, which violates the bound by a factor of three, and looked it.

Land it by folding the ordering and smoothing rules into slide 4's caption.

(This is the version implemented as section VI of
[`interactive_explanations.html`](interactive_explanations.html).)
