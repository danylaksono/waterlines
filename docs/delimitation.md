# Waterlines and maritime delimitation

_A note on what the seam between two islands actually is, why it is not a
maritime boundary, and how far off it is._

Raised by a colleague working on the geospatial side of the law of the sea, who
looked at §VI of [`interactive_explanations.html`](interactive_explanations.html)
— "the accidental beauty" — and observed that the seam forming between two
islands looks like the object UNCLOS practitioners construct by Delaunay
triangulation between basepoints.

It is. The correspondence is exact, it is already documented in the delimitation
literature, and it runs deeper than the median line alone. What follows is the
correspondence, the closed-form error, and an honest account of what this
implementation could and could not be used for.

---

## 1. The correspondence

§3 of [`methodology.md`](methodology.md) defines a waterline as a level set of
the distance-to-coast function

$$
D(x) = \operatorname{dist}(x, \partial\Omega), \qquad
\Gamma_i = \{\, x : D(x) = d_i \,\},
$$

and observes under **(P2)** that where two islands face each other, the locus at
which offsets self-intersect is the medial axis of the water — an edge of the
generalized Voronoi diagram of the polygon set.

That is, verbatim, the geometry of UNCLOS delimitation. Kastrisios (2014) states
it in a footnote to his median-line construction: the median line segments are
Voronoi edges, and the basepoints and straight baselines are the generators for
which the plane is partitioned by the nearest-neighbour rule (citing Gold,
Remmele & Roos 1997, _Voronoi Methods in GIS_). Kastrisios & Tsoulos (2016) then
built an automated delimitation methodology on exactly that tessellation.

| Waterlines (`methodology.md` §3) | Law of the sea |
| --- | --- |
| medial axis of the water $\Omega^c$ | strict equidistance / median line |
| edge of the generalized Voronoi diagram | median line segment |
| coastline polygon $\partial\Omega$ | baseline — normal, straight, or bay closing line |
| point–point bisector | straight median segment between two basepoints |
| point–segment bisector (a parabola) | parabolic segment, basepoint against straight baseline |
| segment–segment bisector | straight segment between two straight baselines |
| triple point of the medial axis | **turning point**, equidistant from three basepoints |
| level set $D(x) = d$ | **outer limit** at $d$ M — the envelope of arcs |

Delaunay enters as the dual. A turning point is equidistant from three
basepoints, so it is the circumcentre of a Delaunay triangle spanning basepoints
on opposing coasts, and the empty-circumcircle property is precisely the test
Kastrisios gives for verifying a candidate turning point: draw the circle
through the three basepoints and check it strikes no other coast. That is why
practitioners describe the construction as triangulation between two islands.

### 1.1 The second correspondence, which is closer

The median line is the analogy people reach for, but the **outer limit** is the
tighter one. Article 4 defines the outer limit of the territorial sea as the
line every point of which is at a distance from the nearest point of the
baseline equal to the breadth of the territorial sea — a level set of $D$, no
more and no less. The predominant graphical construction for it is the
**envelope of arcs**: successive 12 M arcs struck from points along the
baseline, the limit being the seawardmost intersecting envelope.

The waterline family $d(i)$ of §4.2 is that construction, drawn at every radius
at once. Kastrisios' Figure 16 — outer limits at 1×, 2×, 3×, 4× the zone
breadth, showing progressively less coastal sinuosity — is, geometrically, a
waterlines render with `count: 4` and a linear spacing exponent.

There is a third coincidence worth recording. The delimitation literature
already contains a construction named the **"water-line method"**, described as
derived from an ancient manual cartographic technique for stepping a line off a
coast. That is the same engraving practice this repository reimplements. The
technique reached the law of the sea and the aesthetics of nautical charts from
a common ancestor.

---

## 2. Where this implementation departs

Four gaps, in descending order of severity. The first is the finding; the rest
are engineering.

### 2.1 The metric is Web Mercator pixels, and the bias has a closed form

[`src/core/mercator.js`](../src/core/mercator.js) works in normalised Web
Mercator, and §4.3 parameterises every distance in CSS pixels. Mercator is
conformal, so the distance field is locally isotropic and the seam _looks_
correct at any single place on the map. But the scale factor $k(\varphi) = \sec\varphi$
varies with latitude, so a locus of equal **pixel** distance is not a locus of
equal **ground** distance whenever the two generators sit at different
latitudes.

For the clean case — two opposing coasts running east–west at latitudes
$\varphi_m \pm h$ — the error can be written down exactly. Web Mercator
ordinate $y(\varphi) = \ln\tan(\pi/4 + \varphi/2)$ has $y' = \sec\varphi$ and
$y'' = \sec\varphi\tan\varphi$. The true median lies at the mid-**latitude**
$\varphi_m$; the pixel bisector lies at the mid-**ordinate**. Expanding about
$\varphi_m$, the mid-ordinate exceeds $y(\varphi_m)$ by $\tfrac12 y'' h^2$, so
the pixel bisector sits at latitude $\varphi_m + \Delta\varphi$ with

$$
\Delta\varphi \;=\; \frac{\tfrac12 y''(\varphi_m)\,h^2}{y'(\varphi_m)}
\;=\; \tfrac12 \tan(\varphi_m)\, h^2 ,
\qquad
\Delta s \;\approx\; \tfrac12 R \tan(\varphi_m)\, h^2 .
$$

Three things follow, and all three matter:

1. **The bias is poleward.** $\Delta\varphi > 0$ in the northern hemisphere and
   symmetric in the south: the Mercator seam always sits nearer the
   higher-latitude coast. It is a systematic bias, not noise — it favours one
   state every time.
2. **It vanishes at the equator** and grows as $\tan\varphi$. This is the reason
   the effect is invisible in the Nusantara renders that motivated the whole
   repository, and it would be a mistake to generalise from them.
3. **It is quadratic in the separation.** Narrow straits are nearly safe; wide
   opposite-coast delimitations are not.

| $\varphi_m$ | coasts | separation | $\Delta s$ |
| --- | --- | --- | --- |
| 0° | 2°S / 2°N | 445 km | 0 |
| 10° | 8° / 12° | 445 km | 0.69 km (0.37 M) |
| 40° | 38° / 42° | 445 km | 3.3 km (1.8 M) |
| 60° | 58° / 62° | 445 km | 6.7 km (3.6 M) |
| 72° | 70° / 74° | 445 km | 11.9 km (6.4 M) |

Published turning points are given to a fraction of an arc-second — order 3 m.
Even the equatorial case is more than two orders of magnitude coarser than that,
and the Barents-Sea case is nearly four.

An earlier estimate of 1.4 km for the 8°/12° case, made by weighting distances
by representative $\sec\varphi$ values, was wrong; the exact figure is 0.69 km.
The interactive page computes it from $y(\varphi)$ directly rather than from the
small-$h$ expansion.

### 2.2 It produces no vector

§4.1 is explicit: _"The result is a raster, not a vector. There is no path to
export, hit-test, or label along."_ A maritime boundary is a coordinate list in
a treaty annex. Raster resolution caps the achievable precision anyway — a
500 km scene on a 1920 px viewport is ~260 m/px, so the seam is localised to
±130 m at best, before the jump-flooding approximation of the GL path
(Rong & Tan 2006) adds its own error.

Note that 260 m/px is the same order as the 690 m Mercator bias at 10°. Fixing
one without the other buys nothing.

### 2.3 No basepoint provenance

The method consumes an entire coastline polygon and returns a seam carrying no
record of which coastal features control which stretch. But stage one of the
ICJ three-stage method (_Black Sea_, 2009) is the selection of "the most
appropriate base points" — a contested legal act, not a geometric given. Courts
discard basepoints: Serpents' Island, Qit'at Jaradah. Without provenance there
is nothing to adjust at stage two and nothing to argue about.

### 2.4 It deletes the features that decide the answer

[`README.md`](../README.md) — _"Very small islands are dropped as you zoom
out"_, via `lod.minRingPx`. Rocks, islets and low-tide elevations are routinely
the _controlling_ basepoints; a single islet can swing a boundary by tens of
kilometres over its whole length. The LOD pyramid is a correctness bug in this
domain before the metric problem is even reached.

Related: the input is generalised Natural Earth coastline, not a charted
low-water line at a declared vertical datum, and the README already warns that
it disagrees with the basemap's own coastline as you zoom in.

---

## 3. Assessment

**Not an alternative delimitation methodology.** Delimitation needs coordinates
on an ellipsoid; this produces a picture. Closing §2.1–2.4 means replacing the
distance metric, the output stage, the generator model and the LOD — a different
program that happens to share a theorem.

Three uses are real:

- **Exploratory and sensitivity visualisation.** The standing complaint about
  strict equidistance is that it yields impractically many turning points
  requiring simplification and negotiation. A 60 fps distance field showing the
  whole field, with the seam moving live as a candidate basepoint is added or a
  straight baseline is shifted, is not something the exact tools give you
  interactively. It feeds an exact computation; it does not replace one.
- **Teaching.** Re-scale `extent` from pixels to nautical miles and the ripples
  _are_ the 12 / 24 / 200 M envelope-of-arcs family. §VI is already a correct
  illustration of point–point, point–segment and segment–segment bisector
  structure. This is what [`delimitation.html`](delimitation.html) does.
- **Coarse-to-fine.** Use the raster field to find candidate controlling
  basepoints cheaply, then hand only those to exact geodesic computation.

---

## 4. What would have to change

| | now | required |
| --- | --- | --- |
| metric | Web Mercator pixels | geodesic on WGS84 |
| output | raster | turning-point coordinate list |
| generators | whole coastline polygon | selected legal basepoints, with provenance per segment |
| detail | LOD drops small rings | every rock, islet and low-tide elevation retained |
| accuracy | ~10² m | ~10⁰ m |
| source | Natural Earth | charted low-water line at a declared datum |

---

## 5. Sources

Retrieved 2026-08-11. Two of these were reachable only as abstracts and search
summaries — ScienceDirect and ResearchGate returned 403 — and are marked.

- Kastrisios, C. (2014). _Methods of Maritime Outer Limits Delimitation_.
  Nausivios Chora vol. 5, E-3–E-24.
  <https://nausivios.snd.edu.gr/docs/2014E1.pdf> — full text; the source for the
  envelope of arcs, replica line, median-line construction and the Voronoi
  footnote.
- Kastrisios, C. & Tsoulos, L. (2016). _A cohesive methodology for the
  delimitation of maritime zones and boundaries_. Ocean & Coastal Management.
  <https://www.sciencedirect.com/science/article/abs/pii/S0964569116301247> —
  _abstract only_.
- Gold, C.M., Remmele, P.R. & Roos, Th. (1997). _Voronoi Methods in GIS_. In
  Algorithmic Foundations of Geographic Information Systems, Springer, 21–35.
  Cited via Kastrisios (2014); not consulted directly.
- Zhang et al. _An equidistance/equiratio method of maritime delimitation on the
  Earth ellipsoid_.
  <https://www.sciencedirect.com/science/article/pii/S1385110122001605> —
  _abstract only_; source for the "water-line method" naming.
- ICJ, _Maritime Delimitation in the Indian Ocean (Somalia v. Kenya)_, judgment
  of 12 October 2021. <https://www.icj-cij.org/node/106073> — three-stage
  method.
- Dundua, N. _Delimitation of maritime boundaries between adjacent States_.
  UN–Nippon Foundation fellowship paper.
  <https://www.un.org/depts/los/nippon/unnff_programme_home/fellows_pages/fellows_papers/dundua_0607_georgia.pdf>
- Rong, G. & Tan, T.-S. (2006). _Jump flooding in GPU with applications to
  Voronoi diagram and distance transform_. I3D 2006.
  <https://www.comp.nus.edu.sg/~tants/jfa/i3d06-submitted.pdf> — already
  reference [RT1] in `methodology.md`.
- UNCLOS, arts. 4, 7, 13, 15, 74, 83.
  <https://www.un.org/depts/los/convention_agreements/texts/unclos/unclos_e.pdf>

The $\tfrac12 R\tan(\varphi_m)h^2$ result in §2.1 is derived here and is not
from the literature. It is a straightforward expansion and is almost certainly
not new, but I did not find it stated anywhere; treat it as unreviewed.
