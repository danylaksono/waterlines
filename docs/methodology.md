# Methodology

*Rendering cartographic waterlines over an interactive web map by
raster stroke expansion*

This document records the methods used in this repository, the reasoning
behind them, the measurements that drove the design, and — at least as
usefully — the approaches that were tried and abandoned. It is written as
source material for a paper rather than as user documentation; for the latter
see the [README](../README.md).

> **On the references.** The citations below are to work I believe is real and
> relevant, given with enough detail to locate. Bibliographic details (page
> numbers, volume numbers, exact titles) should be verified against the
> originals before publication. Where I am uncertain about a detail I say so.

---

## 1. Scope and claim

**Waterlines** — also called *water lining*, *coastal vignetting*, or
*shore ripples* — are the concentric lines engravers drew in the sea alongside
a coastline on nineteenth- and early twentieth-century charts. They emphasise
the shoreline, separate land from water at a glance, and give the sea a
texture. They are ornament with a job.

The technique in this repository is Olivia Vane's, from her Observable notebook
*Drawing waterlines on maps* [V1]. The contribution here is not the visual
effect but the **engineering required to run it on a live, pannable, zoomable
map at 60 fps**, which turns out to require a different architecture from the
one a static image needs.

The claim being made, precisely:

> Waterlines can be rendered as a 2D-canvas overlay on a WebGL map such that
> the map's interaction frame rate is statistically indistinguishable from the
> same map with no overlay, at every zoom level, including while the overlay is
> re-rendering.

Section 7 gives the measurements supporting that claim, and Section 10 states
what it does *not* claim.

---

## 2. Background

### 2.1 Cartographic

Water lining is discussed in the classic cartographic design literature as a
means of shoreline emphasis and figure–ground separation; Imhof [I1] and
Robinson et al. [R1] are the standard references for the design tradition,
though neither treats it algorithmically. It is worth being explicit that
waterlines in this sense are **not bathymetric**: the lines do not encode
depth, and their spacing carries no metric meaning. They are a graphic device
operating in the space of the *map*, not the space of the *world* — a
distinction that has a direct consequence for the implementation (Section 4.3).

### 2.2 Computational

Vane's notebook [V1] contains two implementations. The first computes $N$
geometric buffers with `@turf/buffer` and draws their outlines; the notebook
itself warns that this takes roughly forty seconds. The second — the one this
work builds on — abandons geometric offsetting entirely and produces the bands
by **rasterisation and compositing**, using `destination-out` to hollow out a
wide stroke. That formulation is credited in the notebook to Woodruff's
treatment of canvas compositing for cartography [W1], and the curve smoothing
approach to Bremer [B1].

The compositing operator itself is Porter–Duff `DEST_OUT` [PD1].

---

## 3. Problem statement

Let $\Omega \subset \mathbb{R}^2$ be the (open) land region, a finite union of
polygons with boundary $\partial\Omega$, and let $\Omega^c$ be the sea. Define
the distance to the coast

$$
D(x) \;=\; \operatorname{dist}(x, \partial\Omega) \;=\; \inf_{y \in \partial\Omega} \lVert x - y \rVert .
$$

The $i$-th waterline is the level set

$$
\Gamma_i \;=\; \{\, x \in \Omega^c \;:\; D(x) = d_i \,\}, \qquad
d_1 > d_2 > \cdots > d_N > 0 .
$$

Rendering waterlines is therefore the problem of drawing a family of
**offset curves** of $\partial\Omega$, restricted to the exterior, and given
some stroke weight $\tau_i$, drawing the band
$\{ x : |D(x) - d_i| \le \tau_i/2 \}$.

Three properties of this problem drive everything that follows.

**(P1) Exact offset curves are expensive and badly behaved.** The offset of a
polygon at distance $d$ is a curve of line segments and circular arcs; it
self-intersects wherever $d$ exceeds the local radius of curvature of the
medial axis, and its *topology changes with $d$* — separate islands' offsets
merge as $d$ grows. Removing the self-intersections is the hard part. The
literature on offset approximation and its pitfalls is substantial; Elber, Lee
and Kim [E1] survey the approximation methods, and Farouki [F1] treats offsets
of polynomial curves in depth. Practical polygon offsetting in a GIS setting
(what `turf.buffer` does) is a Minkowski-sum construction followed by a
self-intersection cleanup, and it is the reason the notebook's first
implementation is slow.

**(P2) The self-intersections are exactly where the interesting structure is.**
The locus at which an offset self-intersects is the medial axis of $\Omega^c$
[BL1]. Where two islands face each other, that locus is an edge of the
*generalized Voronoi diagram* of the polygon set [A1]. This is why dense
waterlines between close islands visually resolve into a Voronoi-like
partition of the water — an effect Vane noticed and remarked on [V1]. It is not
an artefact; it is the medial axis becoming visible.

**(P3) For this application the offsets do not need to exist as vectors.**
They only need to be *drawn*. That is the opening the method exploits.

---

## 4. Method

### 4.1 The stroke-expansion identity

Stroking a path $P$ with a round pen of width $w$ paints exactly the set of
points within $w/2$ of $P$ — the Minkowski sum $P \oplus B_{w/2}$ where $B_r$ is
the closed disc of radius $r$:

$$
\operatorname{stroke}(P, w) \;=\; \{\, x : \operatorname{dist}(x, P) \le w/2 \,\}.
$$

This is the definition of a stroke, and every 2D rasteriser implements it
(modulo the join and cap policy at the ends and corners — see §4.5.4). The
essential consequence is that for $w' < w$,

$$
\operatorname{stroke}(P, w) \;\setminus\; \operatorname{stroke}(P, w')
\;=\; \{\, x : w'/2 < \operatorname{dist}(x, P) \le w/2 \,\},
$$

which is precisely an **annular band about $P$ at distance $w'/2$ to $w/2$** —
a waterline of thickness $(w - w')/2$ on each side, sitting at distance
$\approx w/2$ from the path.

The set difference is realised by the Porter–Duff `DEST_OUT` operator [PD1],
available in the HTML canvas as `globalCompositeOperation = 'destination-out'`,
which for opaque source coverage $\alpha_s$ leaves
$C_\text{out} = C_\text{dst}(1 - \alpha_s)$. Drawing the wide stroke and then
erasing the narrow one yields the band directly.

The whole algorithm is then:

```text
for i = 0 .. N:                       # outermost first
    w  ← 2·d_i                        # pen diameter = twice the offset distance
    t  ← τ_i                          # visible line weight
    stroke(P, w + t)  with colour_i, alpha_i     # a very fat line
    stroke(P, w)      with DEST_OUT               # hollow out its middle
fill(P, evenodd) with DEST_OUT        # punch out the land interior
```

**Why this is fast.** No offset curve is ever constructed. The rasteriser
computes the stroke outline — a polygon approximating the Minkowski sum — and
fills it with a nonzero/union rule, so self-intersections (P1) are resolved
implicitly and for free by the fill rule, and topology changes (islands
merging) require no special handling whatsoever. The medial-axis structure (P2)
emerges automatically.

**What is given up.** The result is a raster, not a vector. There is no path
you can export, hit-test, or label along. And the band is only as accurate as
the rasteriser's stroke tessellation.

**Ordering is not free.** Pass $i+1$ erases a disc of radius $d_{i+1} < d_i$,
which lies strictly inside the region already cleared by pass $i$'s erase —
*provided passes run outermost-first*. Reversing the order would have each wide
erase destroy the narrow bands already drawn. Consequently:

> A partially executed waterline render is not a valid image.

This single fact is responsible for a large part of the architecture in
Section 4.8: it means progressive rendering must be done **off-screen and
double-buffered**, never incrementally on the visible surface.

Finally, every pass also paints the inward half of its stroke, which lies under
the land. Rather than clip $N$ times, the land interior is removed once at the
end with a single `DEST_OUT` fill using the even-odd rule (which makes holes
fall out without any winding-order bookkeeping — a useful simplification over
the notebook, which had to `turf.rewind` its input to satisfy `d3.geoPath`).

### 4.2 The spacing, weight and opacity scales

Distances are assigned by a power scale, following [V1]. With $N$ lines,
outermost reach $E$ and innermost inset $s$:

$$
d(i) \;=\; E + (s - E)\left(\frac{i}{N}\right)^{k}, \qquad i = 0,\dots,N,
$$

so $d(0) = E$ and $d(N) = s$. This is `d3.scalePow` semantics [D1]: the power
transform is applied to the domain and interpolation is linear in the
transformed space.

The gap between consecutive lines is

$$
\Delta(i) \;=\; d(i) - d(i+1) \;\approx\; (E-s)\,\frac{k}{N}\left(\frac{i}{N}\right)^{k-1}.
$$

Two things follow, and both matter in practice:

1. **The exponent controls where the lines crowd.** Since
   $\Delta(i) \propto (i/N)^{k-1}$, for $k < 1$ the gap *shrinks* as $i \to N$,
   i.e. the lines bunch against the shore — the engraved-chart look. For
   $k > 1$ they bunch at the outer edge. $k = 1$ is even spacing.

2. **There is a hard limit on $N$.** The tightest gap, at the inner end, is

   $$
   \Delta_{\min} \;\approx\; \frac{k\,(E-s)}{N}.
   $$

   Requiring $\Delta_{\min} \ge \delta$ for some minimum legible separation
   $\delta$ gives

   $$
   N \;\le\; \frac{k\,(E - s)}{\delta}.
   $$

   With $\delta \approx 2$ px this is the design rule the presets follow. For
   the `antique` preset ($k = 0.62$, $E = 46$, $s = 1.5$) it gives
   $N \le 13.8$, and the preset uses $N = 14$. Exceeding this bound is the
   single most common way to make the output look wrong: the lines fuse into a
   dark halo rather than reading as lines. An earlier iteration of this work
   shipped presets with $N = 22$ at $E = 34$, which violates the bound by a
   factor of three, and looked it.

Line weight and opacity use the same scale family, with weight increasing and
opacity rising towards the shore, so the outermost ripples fade out. These are
aesthetic choices inherited from [V1] and are not load-bearing.

### 4.3 Screen-space parameterisation

$E$, $s$ and $\tau_i$ are specified in **CSS pixels**, not ground units. The
waterlines therefore have a constant appearance at every zoom, and their extent
in metres scales as $2^{-z}$.

This is a deliberate cartographic decision following from §2.1: waterlines are
a device of the map, not a measurement of the world, so they belong in map
space. It also has an engineering consequence — the rendering cost per frame is
bounded by viewport area rather than by geographic extent, which is what makes
the cost analysis in Section 5 tractable.

(A geographic parameterisation is a trivial variant: fix $E$ in metres and
convert per frame. It is not implemented because it is not what the effect is
for, and because it makes the cost unbounded as you zoom in.)

### 4.4 Coordinate system, and the affine property

All geometry is held in **normalised Web Mercator** [S1]: $x, y \in [0,1]$ over
the square world, with

$$
x = \frac{\lambda + \pi}{2\pi}, \qquad
y = \frac{1}{2} - \frac{1}{4\pi}\ln\!\left(\frac{1+\sin\varphi}{1-\sin\varphi}\right),
$$

for longitude $\lambda$ and latitude $\varphi$, clamped to
$|\varphi| \le 85.051129^\circ$.

**The key structural observation.** For a Web Mercator map view with pitch $0$,
the map from normalised mercator to screen pixels is *exactly affine*:

$$
\begin{bmatrix} x_s \\ y_s \end{bmatrix}
= \underbrace{\sigma R(\theta)}_{A}
\begin{bmatrix} u \\ v \end{bmatrix} + \mathbf{t},
\qquad \sigma = 256 \cdot 2^{\,z} \;\text{or}\; 512 \cdot 2^{\,z},
$$

with $R(\theta)$ the rotation by the map bearing and $\sigma$ the world size in
pixels (the tile-size convention differs between libraries; MapLibre and
deck.gl both use 512).

An affine map is exactly what `CanvasRenderingContext2D.setTransform` accepts.
Therefore **the entire per-frame projection can be delegated to the
rasteriser**: geometry is projected into a `Path2D` once, and each frame sets
six numbers. No coastline vertex is touched by JavaScript during a frame. This
is the difference between an overlay that stutters and one that does not, and
it is the reason the architecture is built around a fixed mercator space rather
than around `map.project()`.

**Recovering $A$ and $\mathbf{t}$.** Rather than reach into private map
internals, the transform is recovered by probing. Let $c$ be the view centre in
mercator and $\delta$ a small offset ($\approx$ 128 px expressed in mercator
units). Projecting three points gives

$$
A_{\cdot 1} = \frac{\pi(c + \delta e_1) - \pi(c)}{\delta}, \quad
A_{\cdot 2} = \frac{\pi(c + \delta e_2) - \pi(c)}{\delta}, \quad
\mathbf{t} = \pi(c) - A c,
$$

where $\pi$ is the host's public projection function. Three projections per
frame, exact for pitch $0$, and bearing is recovered for free. The probe
direction is flipped near the world edge to avoid crossing the antimeridian or
the latitude clamp.

**Line widths under the transform.** With path coordinates in "world pixels at
LOD zoom $z_0$", the canvas transform carries uniform scale
$\sigma' = \rho \cdot 2^{\,z - z_0}$ for device pixel ratio $\rho$. Since
`lineWidth` is expressed in path units and scaled by the CTM, achieving a
target screen width $W$ requires

$$
\ell = \frac{W \cdot 2^{\,z_0}}{2^{\,z}} \;=\; W\,2^{\,z_0 - z},
$$

independent of $\rho$ (the ratio is folded into the transform).

**Pitch.** A tilted view is a *projective* transform, not affine, and cannot be
expressed by `setTransform`; a 2D canvas has no perspective divide. This is a
hard limitation of the approach, not an implementation gap (Section 10).

### 4.5 Geometry preparation

Work that depends only on zoom — not on pan position — is done once per integer
zoom level and cached. There are four stages.

#### 4.5.1 Flattening to rings

GeoJSON is reduced to a flat list of closed rings held as interleaved
`Float64Array`s in normalised mercator, each with a cached bounding box. The
renderer never looks at features, holes or winding order: waterlines are
strokes, so winding is irrelevant, and the land mask uses the even-odd rule, so
holes are handled by simply being present as ordinary rings.

#### 4.5.2 Simplification

Rings are simplified with Ramer–Douglas–Peucker [R2, D2] at a tolerance of
0.6 px *at the level's own zoom*, i.e. $\varepsilon = 0.6 / (512 \cdot 2^{z_0})$
in mercator units. RDP bounds the perpendicular distance from every discarded
vertex to the retained polyline by $\varepsilon$, hence the one-sided Hausdorff
error is sub-pixel at that zoom by construction.

Two wrinkles worth recording:

- **Closed rings have no endpoints.** RDP needs two anchors; naively running it
  on a ring can collapse the whole thing. Here vertex 0 and the vertex furthest
  from it are pinned and the two arcs are recursed separately. The result
  therefore depends on the choice of starting vertex — a known non-canonicality
  of RDP on closed curves. Visvalingam–Whyatt [V2] avoids this and produces
  perceptually better generalisation, and would be a defensible substitution.

- **Ring selection changes topology.** Rings whose bounding box is smaller than
  1.5 px on screen are dropped. This is selection, not simplification, and it
  makes islands appear and disappear across zoom levels. The classical
  treatment of how many objects to retain when scale changes is Töpfer and
  Pillewizer's radical law [T1]; the threshold used here is a cruder
  screen-space rule chosen because it bounds rendering cost directly. The
  Indonesian archipelago makes this consequential: the source data has 1,740
  rings, of which 712 survive at zoom 4.

#### 4.5.3 Curve smoothing

A wide pen amplifies every sharp vertex of the source geometry into a spike, so
the coastline must be smoothed before it is stroked. Following [V1] (and via
[B1]) the smoothing is a **centripetal Catmull–Rom spline** [CR1].

For a knot sequence with $t_{i+1} = t_i + \lVert P_{i+1} - P_i \rVert^{\alpha}$,
the parameter $\alpha$ selects uniform ($\alpha = 0$), centripetal
($\alpha = 1/2$) or chordal ($\alpha = 1$) parameterisation. Yuksel, Schaefer
and Keyser [Y1] prove that the centripetal choice is the only one in this
family guaranteed to produce **no cusps and no self-intersections within a
segment**. That guarantee is not cosmetic here: a cusp in the smoothed
coastline becomes a spike under a 90-pixel pen, so $\alpha = 1/2$ is load-bearing.

Each span is converted to a cubic Bézier. With $\ell_{ab} = \lVert P_b - P_a
\rVert^{\alpha}$ the control points for the segment $P_1 \to P_2$ are

$$
C_1 = \frac{P_1\left(2\ell_{01}^2 + 3\ell_{01}\ell_{12} + \ell_{12}^2\right) - P_0\,\ell_{12}^2 + P_2\,\ell_{01}^2}{3\ell_{01}\left(\ell_{01} + \ell_{12}\right)},
$$

$$
C_2 = \frac{P_2\left(2\ell_{23}^2 + 3\ell_{23}\ell_{12} + \ell_{12}^2\right) + P_1\,\ell_{23}^2 - P_3\,\ell_{12}^2}{3\ell_{23}\left(\ell_{23} + \ell_{12}\right)},
$$

which is a direct port of the formulation in `d3-shape` [D1], itself following
Barry and Goldman's recursive evaluation [BG1].

#### 4.5.4 Flattening the curve, and the join policy

The cubics are **flattened to line segments in our own code**, not handed to
the canvas as curves. Uniform subdivision is used, with the segment count taken
from the standard second-difference error bound: for a cubic with second
differences $\Delta^2 P_0 = P_0 - 2P_1 + P_2$ and $\Delta^2 P_1 = P_1 - 2P_2 +
P_3$, the deviation of the $n$-segment uniform polyline from the curve is
bounded by

$$
\epsilon \;\le\; \frac{3}{4n^{2}} \max\left(\lVert\Delta^2 P_0\rVert, \lVert\Delta^2 P_1\rVert\right)
\quad\Longrightarrow\quad
n = \left\lceil \sqrt{\frac{3M}{4\epsilon}} \right\rceil,
\; M = \max\left(\lVert\Delta^2 P_0\rVert, \lVert\Delta^2 P_1\rVert\right).
$$

This bound is commonly known as *Wang's formula* and is standard in path
rendering; it appears in the GPU path-rendering literature [K1] and in modern
vector renderers. (I am confident about the formula and its use; the primary
attribution — usually given as Wang, G.-J., 1984, on Bézier subdivision — is
one I would verify before citing.)

Adaptive subdivision would be the textbook choice, but the spans here are short
hops between adjacent coastline vertices where adaptivity buys nothing, and
uniform subdivision is branch-free and allocation-free.

The reason for flattening at all is empirical and is discussed in §8.5: the
first `stroke()` of a `Path2D` containing ~9,000 cubics cost 1.6 s, because
that is when the rasteriser flattens it, and the combined path is rebuilt
whenever the visible ring set changes. Moving the flattening into our own code
makes it a once-per-LOD cost we control.

Flattening alone, however, made matters **worse** (§8.5), because round joins on
a path of tens of thousands of short segments generate a great deal of extra
geometry. The joins are therefore set to `bevel`. On an already-smooth
flattened curve, bevel and round joins are visually indistinguishable; the
difference is roughly 25 % of total draw time.

### 4.6 Level-of-detail pyramid and viewport culling

Simplification, smoothing, flattening and `Path2D` construction are performed
once per **integer zoom** and cached (LRU, 4 levels). Each level stores its
geometry in "world pixels at that level's zoom", which keeps path coordinates
in a well-conditioned numeric range and makes the per-frame transform a small
scale factor ($0.5\times$–$2\times$) rather than a scale of $10^6$.

A level is **never built during a gesture**: while the view is moving, the
nearest already-built level is used and the correct one is queued on an idle
callback.

Per frame, rings are rejected by bounding box against the viewport padded by
the ripple extent (a ring can be off-screen and still throw waterlines into
view). The surviving rings are combined into a single `Path2D`, cached against
a signature of the visible set, and rebuilt only when that set actually
changes — a few times per gesture rather than a few times per frame.

**Why one combined path rather than per-ring strokes.** A single `stroke()` of
a multi-subpath path composites the union of the strokes once; $n$ separate
`stroke()` calls composite sequentially, which double-blends wherever two
islands' bands overlap and $\alpha < 1$. Since overlapping bands are exactly
the interesting case (P2), the combined path is worth the cache machinery. A
residual approximation remains and is stated in §10.

### 4.7 Raster caching and reprojection

The cost of this technique is **rasterised area**, not vertices: each pass
paints a band of width $2E$ along the entire visible coastline, twice. At
continental zoom this is tens of millions of pixels per frame. No geometry
optimisation touches it.

But it does not have to happen every frame. Observe that with $A$ fixed
(constant zoom and bearing), changing $\mathbf{t}$ **translates the image
rigidly**: the waterline picture is the same picture, moved. So the overlay
renders into a canvas larger than the viewport by a margin $p$ and, while the
view slides within that margin, simply blits it.

For a general change of view, let the bitmap have been rendered with
$(A_0, \mathbf{t}_0)$ and let the current view be $(A, \mathbf{t})$. A mercator
point sat at $s_0 = A_0 p + \mathbf{t}_0$ and belongs at $s = A p + \mathbf{t}$,
so

$$
s = L\,s_0 + \left(\mathbf{t} - L\,\mathbf{t}_0\right), \qquad L = A A_0^{-1},
$$

and the blit is a single `drawImage` under the affine $L$, offset by the
padding baked into the bitmap. Reuse is permitted when (a) the four viewport
corners map back inside the cached rectangle, and (b) the scale ratio
$\sqrt{|\det L|}$ lies in $[0.75, 1.8]$, beyond which the resampling is either
too coarse to cover or too soft to look right.

Under zoom and rotation this is only an *approximation*: line widths scale with
the gesture, which is geometrically wrong. It is wrong only mid-gesture, and
the correct image is rendered the moment the view settles. This is the same
raster-reprojection compromise tiled basemaps make when zooming between tile
levels [SI1].

### 4.8 Scheduling

This is where the design differs most from a static implementation, and where
most of the iteration went.

#### 4.8.1 Off-screen, double-buffered, progressive

Because a partially executed render is not a valid image (§4.1), refreshes run
into a **hidden second canvas** while the previous bitmap stays on screen —
the "show stale, render fresh" contract of a tiled map. A refresh is decomposed
into steps (one step = one pass, plus a setup step and a finishing step), and
some number of steps are executed per frame. Buffers are pooled at exactly two;
allocating a fresh canvas is expensive enough to dominate a measurement if you
let it (§8.7).

#### 4.8.2 The frame budget, and an unobservable cost

The natural design is predictive frame budgeting in the sense of Funkhouser and
Séquin [FS1]: measure the cost of work, and admit as much of it per frame as
the budget allows.

The difficulty is that **the cost is not observable from JavaScript**. A 2D
canvas records drawing commands and rasterises them later, so a stopwatch
around $N$ `stroke()` calls reports a number that has nothing to do with the
work. In this codebase it reported 0.1 ms for frames that were in fact taking
100 ms. Forcing a synchronisation to make the measurement honest is worse
(§8.3).

The signal actually used is the **observed wall-clock interval between
consecutive frames**, which is a *lagged* proxy: the cost of frame $n$ shows up
as a long gap before frame $n+1$. The controller adjusts steps per frame
multiplicatively in both directions around a 20 ms target.

#### 4.8.3 Yielding, which pacing cannot substitute for

Pacing turned out to be insufficient, for a reason that is structural rather
than tunable:

> **One pass over a continental coastline can cost more than an entire frame,
> and one pass is the smallest unit that leaves the bitmap in a valid state.**

Measured on the target hardware, a single pass at zoom 4.2 over 712 rings costs
$\approx$ 130 ms. No step count makes that fit in 16.6 ms. Lowering the budget
to 8 ms changed the median frame interval during a refresh from 99 ms to
133 ms — it made things slightly *worse*, because the controller was already
pinned at its minimum of one step.

The resolution is **cooperative yielding**: while the user is moving the map, a
refresh does not advance at all, and the cached bitmap is blitted instead. It
resumes when the gesture ends. The sole exception is a view the cache cannot
cover, where rendering something coarse beats rendering nothing.

This is the single change that made the interaction claim in Section 1 true.
Before it, dragging during a refresh had a median frame interval of 99.4 ms
(p90 484 ms); after it, 16.6 ms.

#### 4.8.4 Draft, then refine

From a cold cache a full render of the heaviest view takes on the order of a
second, and an empty map for that long is worse than soft waterlines quickly.
Refreshes at rest therefore run in two rungs: a **draft** at half resolution
*and two LOD levels coarser*, then the full-resolution pass which replaces it.

The two reductions are not equally useful, and the asymmetry is informative:

| draft strategy | time to first waterlines |
| --- | --- |
| none (full render only) | $\approx$ 2000 ms |
| half resolution only | $\approx$ 1200 ms (1.6×) |
| half resolution **and** LOD $-2$ | $\approx$ 300 ms (6×) |

Halving the resolution quarters the pixels but yields only a 1.6× speedup,
whereas dropping two LOD levels — roughly a $4\times$ reduction in vertex count
— gives most of the win. **The cost of this workload is dominated by stroke
tessellation, not by fill rate.** That is worth stating as an empirical finding
about canvas path rendering, and it is the opposite of what one assumes when
the algorithm is described as "painting very wide bands".

#### 4.8.5 Quality degradation policy

When the overlay must give something up, it gives up **resolution** — never the
number of lines, never the geometry, and never the line positions. Lines that
soften are far less distracting than lines that move or vanish. This is a
design judgement, not a measured result, and it is stated as such.

---

## 5. Complexity

Let $L$ be the visible coastline length in pixels, $V$ the visible vertex count
at the active LOD, $N$ the number of waterlines, $E$ the extent in pixels, and
$R$ the viewport area in pixels.

| stage | frequency | cost |
| --- | --- | --- |
| GeoJSON → rings | once per dataset | $O(V_\text{src})$ |
| Simplify + smooth + flatten + `Path2D` | once per **zoom level** | $O(V_\text{src} \log V_\text{src})$ |
| Viewport cull | per frame | $O(\text{rings})$, bbox tests only |
| Combined path assembly | per **visible-set change** | $O(V)$ |
| Waterline render | per **refresh** | $O\!\left(N V + \textstyle\sum_i L\,w_i\right)$ |
| Blit | per frame | $O(R)$, one `drawImage` |

The two terms in the render cost are the tessellation term $O(NV)$ and the
fill-rate term $O(L \sum_i w_i)$, where $\sum_i w_i \approx N E$ for the scales
in §4.2. §4.8.4 establishes empirically that **the first term dominates** for
realistic coastline data.

The important structural point is the *frequency* column: the per-frame cost is
a bbox scan plus one `drawImage`. Everything expensive is amortised over zoom
levels, visible-set changes, or refreshes — none of which happen per frame.

---

## 6. Implementation notes

- Zero runtime dependencies. `d3-scale`'s `scalePow` semantics and
  `d3-shape`'s `curveCatmullRomClosed` are reimplemented (≈40 lines) rather
  than depended upon; `@turf/*` is not used at all.
- MapLibre GL and deck.gl are optional peers, touched only by thin adapters.
  The engine takes an affine transform and a size and knows nothing about
  either.
- deck.gl gets a 2D canvas overlay rather than a layer, because the technique
  depends on `destination-out` compositing, which has no equivalent in a
  deck.gl layer. Reimplementing in WebGL means changing the algorithm, not
  porting it (§11).
- The canvas context is acquired with `alpha: true` (the map must show through)
  and `desynchronized: true`.
- The land mask uses `fill(path, 'evenodd')`, which removes all winding-order
  handling from the pipeline.

---

## 7. Evaluation

### 7.1 Protocol

Measurements are produced by `scripts/smoke.mjs`, which drives a real browser
over the Chrome DevTools Protocol with no test framework:

1. Load the example page and wait for the overlay to settle.
2. Install a `requestAnimationFrame` sampler.
3. Synthesise a drag — 25 `Input.dispatchMouseEvent` moves at 30 ms intervals,
   which are real input events, not simulated method calls.
4. Report the distribution of intervals between animation frames.
5. Repeat with the overlay hidden, as a paired control.

Frame *intervals* are the dependent variable throughout, for the reason in
§4.8.2. Overlay-on and overlay-off conditions are measured at the same camera
positions in the same session.

**Configuration.** Chrome headless, GPU rasterisation via ANGLE/D3D11 on an
Intel Arc integrated GPU; viewport 1440 × 900; `devicePixelRatio` 1;
`antique` preset ($N = 14$, $E = 46$ px). Dataset: Natural Earth 10 m land and
minor islands [NE1] clipped to $[85°E, 22°S, 152°E, 16°N]$ — 1,740 rings,
61,512 vertices, 1.2 MB; 712 rings and 8,837 vertices survive culling and
simplification at zoom 4.

### 7.2 Interaction frame rate

| drag condition | overlay off | overlay on |
| --- | --- | --- |
| Nusantara, z 4.2 (712 rings) | 16.4 ms median | 16.7 ms median, p90 17.6 |
| Sulawesi, z 6.0 | 16.4 ms | 16.5 ms, p90 17.6 |
| Bali, z 8.3 | 16.6 ms | 16.5 ms, p90 17.9 |
| Banda, z 10.5 | 16.5 ms | 16.5 ms, p90 17.8 |
| Nusantara, **during an in-flight refresh** | — | 16.6 ms, p90 19.1 |

A 60 Hz display gives a 16.67 ms floor, so every condition is at the vsync
limit. The last row is the one that matters: it is the case that is easy to
avoid measuring by accident (any test that settles the overlay first will miss
it), and it is where the pre-yielding implementation failed badly.

### 7.3 Refresh cost

From a cold cache at the heaviest view, the draft lands in $\approx$ 300 ms and
the full-resolution pass follows in **0.3–4 s across runs**. That spread is
large and is reported honestly: it reflects both the pacing controller's
carried-over state and GPU scheduling. It is a second or two of genuine
rasterisation, not a constant.

While a refresh runs and the user is *not* interacting, the page's frames are
long. Nothing is moving, so nothing is visible; the moment a gesture begins the
refresh yields (§4.8.3).

### 7.4 Cost decomposition (software rasteriser)

To decompose the cost, the same renderer was profiled under SwiftShader —
software rasterisation, roughly an order of magnitude slower, but with the same
*relative* structure and far less scheduling noise. Single full render, 1440 ×
900, zoom 4.2, 692 visible rings, with the earlier $N = 22$ preset:

| configuration | time |
| --- | --- |
| full (`antique`, $N=22$, $E=34$) | 1213 ms |
| $N = 10$ | 573 ms |
| $N = 2$ | 174 ms |
| $E = 8$ px | 439 ms |
| `filled` (no erase pass) | 210 ms |
| land mask disabled | 430 ms |
| pixel ratio 0.5 | 178 ms |
| zoom 6 (247 rings) | 98 ms |
| zoom 8.3 (14 rings) | 23 ms |

Cost is approximately linear in $N$ (≈50 ms per pass), and strongly dependent
on the visible ring count. The `filled` row shows the erase passes are the
larger half of the work; note the rows are not additive, because `DEST_OUT`
compositing does not decompose linearly in this rasteriser.

Per-step timings for a single padded render (1824 × 1284, 712 rings) exposed
the flattening spike discussed in §8.5:

```text
step:      0     1     2    3    4   ...  22   23   final
ms:       18  1634   132   84   71   ...  39   35      5
```

Step 1 is the first `stroke()` on the path, and 58 % of the total render.

### 7.5 Threats to validity

- **One machine, one GPU, one browser.** No cross-device comparison.
- **$n = 3$** for the refresh timings, with high variance; the interaction
  measurements are more stable (25-sample distributions) but also single-run.
- **Headless Chrome** is not identical to headed Chrome in compositing
  behaviour.
- **No user study.** All perceptual claims (§4.8.5, §4.2's legibility bound
  $\delta \approx 2$ px) are design judgements, not findings.
- The cost decomposition in §7.4 was taken with an earlier preset ($N = 22$)
  and is reported at that setting.

---

## 8. Negative results

These are recorded because they cost time, and because the reasoning is more
transferable than the successes.

### 8.1 Geometric buffering per frame

The notebook's own first implementation [V1] computes $N$ buffers with
`@turf/buffer`; it warns of ~40 s for a single static image. Ruled out
immediately, but worth stating as the baseline the raster method replaces.

### 8.2 Timing the drawing calls

`performance.now()` around the stroke loop reported 0.1 ms for frames that were
taking 100 ms. A 2D canvas records commands and rasterises later. Any pacing
built on this signal is built on nothing. **Every published timing for canvas
drawing should be treated as suspect unless the measurement method is stated.**

### 8.3 Forcing a flush to make timing honest

A $1 \times 1$ `getImageData()` after each batch does synchronise the pipeline
and does make the elapsed time meaningful. It also **costs more than the
drawing it was measuring**: with a per-frame readback, a refresh that should
take ~2 s took considerably longer, and the readback dominated the profile.
Repeated readback on a canvas not created with `willReadFrequently` is a
well-known anti-pattern; it can force the implementation to migrate the surface
between GPU and CPU. Pacing on frame intervals needs no readback at all.

### 8.4 Additive step ramping

The pacing controller originally moved steps-per-frame by $\pm 1$. For a
17-step job this spends 17 frames climbing to a rate it could reach in 5.
Replaced with multiplicative increase and decrease. This helped, but was later
revealed as beside the point (§8.6).

### 8.5 Pre-flattening curves — which made things worse, until the joins changed

Flattening the Catmull–Rom cubics to line segments was motivated by a clear
measurement: 1634 ms for the first `stroke()` of a 8,837-cubic path (§7.4).

Flattening alone made the total **worse**: 2827 ms → 4991 ms. Tens of thousands
of short segments with `lineJoin: 'round'` generate far more join geometry than
the cubics did. Setting `lineJoin: 'bevel'` — visually indistinguishable on an
already-smooth curve — recovered roughly 25 %, and coarsening the flattening
tolerance from 0.4 px to 0.75 px recovered more:

| configuration | relative cost |
| --- | --- |
| cubics + round joins | 1.00 |
| cubics + bevel joins | 0.76 |
| flattened 0.4 px + round joins | 0.97 |
| flattened 0.4 px + bevel joins | 0.76 |
| flattened 1.0 px + bevel joins | 0.55 |
| no smoothing + bevel joins | 0.42 |

(Measured under SwiftShader with a fresh canvas per repetition, so the absolute
numbers are inflated by allocation; the ratios are the useful part.)

The general lesson: **changing the representation of a path changes which
rasteriser cost dominates**, and an optimisation targeted at one term can
inflate another.

### 8.6 Raising the frame budget when idle

Superficially free: at rest nothing competes for the frame, so let the refresh
take 50 ms per frame instead of 20 and finish sooner. In practice it made the
controller submit the *entire* refresh in one frame, because it cannot see
rasterisation cost (§8.2) and the lagged signal had not yet caught up. The
commit timestamps duly reported 17 ms for the whole job — measuring submission,
not completion — while the page locked up for seconds. Reverted to a single
budget.

This is the same trap as §8.2 wearing a different hat, and it caught me twice.

### 8.7 Ignoring canvas allocation

An early benchmark created a fresh canvas per repetition and reported 13–18 s
per render, ten times the true cost. The first draw onto a newly allocated
surface is dramatically more expensive than subsequent ones. The production
code pools exactly two buffers and swaps them; the benchmark was simply wrong.

### 8.8 Drafting by resolution alone

Covered in §4.8.4: a half-resolution draft gave only a 1.6× speedup, because
the workload is tessellation-bound rather than fill-bound. The fix was to
reduce geometry as well.

### 8.9 Considered but not implemented

- **Sub-pass scheduling by ring subsets.** Would give finer granularity than
  one pass, which is the remaining obstacle to smooth refresh. Rejected for now
  because splitting a pass into chunks reintroduces the sequential-compositing
  error at overlaps (§4.6) — precisely where the interesting structure is.
- **Distance-field formulation.** Rasterise the land mask once, compute a
  Euclidean distance transform [DA1, FH1], and colour by $D(x)$ with a periodic
  function. This is $O(R)$ once instead of $O(NR)$, and is the mathematically
  natural formulation of §3. Rejected for a CPU implementation: a JS EDT over
  1.3 Mpx plus a per-pixel colouring pass lands in the same order of magnitude
  as the current method while giving up antialiasing quality and all of the
  rasteriser's stroke machinery. It is, however, the right formulation for a
  GPU implementation (§11).
- **Per-pen level of detail.** Using coarser geometry for the wider pens, on
  the grounds that a 90 px pen does not need 0.6 px geometric fidelity. A
  rough calculation suggested only ~1.8× overall, because the many narrow inner
  passes dominate the vertex budget; not pursued.

---

## 9. Trade-offs

| decision | gains | costs |
| --- | --- | --- |
| Raster stroke expansion instead of geometric offsetting | Orders of magnitude faster; self-intersection and topology change handled implicitly | Output is a raster: no vector export, no hit-testing, no label placement along the lines |
| Affine transform delegated to the canvas | No per-vertex work per frame; bearing free | Pitch cannot be supported at all |
| Screen-space extent | Constant appearance across zoom; bounded cost | The lines carry no metric meaning; not usable as a depth encoding |
| LOD pyramid + ring selection | Bounded per-frame cost; sub-pixel geometric error | Islands pop in and out across zoom levels |
| Raster cache with affine reuse | Pans and zooms cost one `drawImage` | Line widths are momentarily wrong mid-zoom |
| Refresh yields to gestures | Interaction is never affected | The image can be stale for a second or more after a gesture |
| Draft-then-refine | First waterlines ~6× sooner | ~25 % more total work; a visible sharpening step |
| One combined path per visible set | Correct compositing where bands overlap | Path rebuild when the visible set changes |
| Bevel joins | ~25 % faster | Marginally different corner geometry at very sharp headlands |
| Zero dependencies | Reproducible, auditable, small | Reimplements ~40 lines of d3 |

---

## 10. Limitations

1. **Pitch is unsupported.** Structural (§4.4), not an implementation gap.
2. **Refresh latency at continental scale.** 0.3 s to draft, up to ~4 s to
   crisp on the tested hardware. Interaction is unaffected, but the image is
   stale meanwhile.
3. **Compositing at band overlaps is approximate.** Successive strokes blend
   sequentially, so where two islands' bands cross, alpha is applied twice. The
   combined-path cache removes this *within* one pass; it remains *across*
   passes. It is also, visually, part of what makes the effect attractive.
4. **Basemap coastline mismatch.** The overlay draws from its own geometry.
   Against a third-party basemap the two coastlines agree at a glance around
   zoom 4–9 and part company above that, since Natural Earth 10 m generalises
   to a kilometre or two.
5. **The overlay is a separate canvas above everything.** It cannot be
   interleaved into a MapLibre style, so basemap labels sit beneath the
   waterlines.
6. **Island selection is not scale-theoretically principled.** A screen-pixel
   threshold, not a radical-law-derived selection [T1].
7. **RDP on closed rings is start-vertex dependent** (§4.5.2).
8. **No perceptual evaluation** (§7.5).

---

## 11. Future work

- **WebGL/WebGPU distance-field implementation.** Compute a signed distance
  field of the coastline once per view and colour it with a periodic function
  — $O(R)$ instead of $O(NR)$, with $N$ becoming free. SDF text and shape
  rendering [G1] and GPU path rendering [K1] are the relevant precedents. This
  would also make the effect a genuine deck.gl layer rather than an overlay.
- **Tile-driven geometry.** Source the coastline from the basemap's own vector
  tiles (`querySourceFeatures`) so the waterlines and the drawn coast are the
  same data at every zoom, resolving limitation 4.
- **Sub-pass scheduling** with a compositing-correct chunking scheme (§8.9).
- **Geographic-unit mode**, for use as a genuine buffer visualisation rather
  than ornament.
- **Perceptual study** of the legibility bound in §4.2 and of the
  soften-versus-move degradation policy in §4.8.5.
- **Cross-device measurement**, particularly on mobile GPUs where the
  fill-rate/tessellation balance may differ from the finding in §4.8.4.

---

## 12. Reproducibility

```sh
npm run data              # rebuild data/ from Natural Earth
npm test                  # 19 unit tests: mercator, RDP, curves, scales, affine
node scripts/smoke.mjs    # 25 end-to-end browser checks, prints the timings
node scripts/smoke.mjs --swift   # same, on SwiftShader
```

- `scripts/build-data.mjs` downloads Natural Earth [NE1], clips with
  Sutherland–Hodgman [SH1], quantises, and writes the GeoJSON. No npm
  dependencies.
- `scripts/browser.mjs` is a ~240-line Chrome DevTools Protocol driver; no
  Playwright or Puppeteer, so the harness has no version drift.
- Unit tests cover the mathematics that can be checked without a browser:
  mercator round-trips and clamping, RDP behaviour on closed rings, Catmull–Rom
  control-point placement and flattening tolerance, `scalePow` semantics, and
  the affine solve/invert pair including under rotation.

Versions used: MapLibre GL 5.24.0, deck.gl 9.1.14, Node 22, Chrome headless
(ANGLE/D3D11).

---

## References

**Primary source**

- **[V1]** Vane, O. *II: Drawing waterlines on maps.* Observable notebook.
  <https://observablehq.com/@oliviafvane/ii-drawing-waterlines-on-maps>
  — the technique, the scales, and the `destination-out` formulation.
- **[W1]** Woodruff, A. *Canvas cartography.* NACIS 2019.
  <https://observablehq.com/@awoodruff/canvas-cartography-nacis-2019>
  — the compositing treatment [V1] builds on.
- **[B1]** Bremer, N. *Simplified curved earth map.* Observable notebook.
  <https://observablehq.com/@nbremer/simplified-curved-earth-map>
  — the curve-smoothing approach adapted in [V1].

**Cartographic design and generalisation**

- **[I1]** Imhof, E. (1982). *Cartographic Relief Presentation.* Walter de
  Gruyter. (English edition; originally *Kartographische Geländedarstellung*,
  1965.)
- **[R1]** Robinson, A.H., Morrison, J.L., Muehrcke, P.C., Kimerling, A.J. &
  Guptill, S.C. (1995). *Elements of Cartography*, 6th ed. Wiley.
- **[T1]** Töpfer, F. & Pillewizer, W. (1966). The principles of selection.
  *The Cartographic Journal*, 3(1), 10–16.
- **[V2]** Visvalingam, M. & Whyatt, J.D. (1993). Line generalisation by
  repeated elimination of points. *The Cartographic Journal*, 30(1), 46–51.
- **[R2]** Ramer, U. (1972). An iterative procedure for the polygonal
  approximation of plane curves. *Computer Graphics and Image Processing*,
  1(3), 244–256.
- **[D2]** Douglas, D.H. & Peucker, T.K. (1973). Algorithms for the reduction
  of the number of points required to represent a digitized line or its
  caricature. *The Canadian Cartographer*, 10(2), 112–122.

**Geometry: offsets, medial axis, Voronoi**

- **[E1]** Elber, G., Lee, I.-K. & Kim, M.-S. (1997). Comparing offset curve
  approximation methods. *IEEE Computer Graphics and Applications*, 17(3),
  62–71.
- **[F1]** Farouki, R.T. (2008). *Pythagorean-Hodograph Curves: Algebra and
  Geometry Inseparable.* Springer.
- **[BL1]** Blum, H. (1967). A transformation for extracting new descriptors of
  shape. In W. Wathen-Dunn (ed.), *Models for the Perception of Speech and
  Visual Form*, MIT Press, 362–380.
- **[A1]** Aurenhammer, F. (1991). Voronoi diagrams — a survey of a fundamental
  geometric data structure. *ACM Computing Surveys*, 23(3), 345–405.

**Curves and path rendering**

- **[CR1]** Catmull, E. & Rom, R. (1974). A class of local interpolating
  splines. In R.E. Barnhill & R.F. Riesenfeld (eds.), *Computer Aided Geometric
  Design*, Academic Press, 317–326.
- **[BG1]** Barry, P.J. & Goldman, R.N. (1988). A recursive evaluation
  algorithm for a class of Catmull–Rom splines. *SIGGRAPH '88*, 199–204.
- **[Y1]** Yuksel, C., Schaefer, S. & Keyser, J. (2011). Parameterization and
  applications of Catmull–Rom curves. *Computer-Aided Design*, 43(7), 747–755.
  — the centripetal ($\alpha = 1/2$) no-cusp, no-self-intersection result.
- **[K1]** Kilgard, M.J. & Bolz, J. (2012). GPU-accelerated path rendering.
  *ACM Transactions on Graphics*, 31(6), 172.
- **[D1]** Bostock, M. et al. *d3-shape* and *d3-scale*.
  <https://github.com/d3/d3-shape>, <https://github.com/d3/d3-scale>
  — the `curveCatmullRomClosed` and `scalePow` formulations ported here.

*Wang's formula for Bézier flattening (§4.5.4) is standard in this literature;
the usual primary attribution is to G.-J. Wang (1984) on Bézier subdivision,
which I would verify before citing.*

**Rasterisation and compositing**

- **[PD1]** Porter, T. & Duff, T. (1984). Compositing digital images.
  *SIGGRAPH '84*, 253–259. — the `DEST_OUT` operator on which §4.1 depends.
- **[SH1]** Sutherland, I.E. & Hodgman, G.W. (1974). Reentrant polygon
  clipping. *Communications of the ACM*, 17(1), 32–42.
- **[G1]** Green, C. (2007). Improved alpha-tested magnification for vector
  textures and special effects. *SIGGRAPH 2007 Courses*, 9–18.
- **[DA1]** Danielsson, P.-E. (1980). Euclidean distance mapping. *Computer
  Graphics and Image Processing*, 14(3), 227–248.
- **[FH1]** Felzenszwalb, P.F. & Huttenlocher, D.P. (2012). Distance transforms
  of sampled functions. *Theory of Computing*, 8, 415–428.

**Interactive rendering and web maps**

- **[FS1]** Funkhouser, T.A. & Séquin, C.H. (1993). Adaptive display algorithm
  for interactive frame rates during visualization of complex virtual
  environments. *SIGGRAPH '93*, 247–254. — the predictive frame-budget
  formulation §4.8.2 adapts.
- **[SI1]** Sample, J.T. & Ioup, E. (2010). *Tile-Based Geospatial Information
  Systems: Principles and Practices.* Springer.
- **[S1]** Snyder, J.P. (1987). *Map Projections: A Working Manual.* USGS
  Professional Paper 1395.

**Data and software**

- **[NE1]** Natural Earth. 1:10 m physical vectors (land, minor islands).
  Public domain. <https://www.naturalearthdata.com/>
- MapLibre GL JS. <https://maplibre.org/>
- deck.gl. <https://deck.gl/>
- OpenHistoricalMap *Woodblock* style (CC0), indexed by
  <https://github.com/pnorman/maplibre-styles>.

**Related work by the same author**

- ScreenGrid — screen-space grid aggregation for MapLibre GL JS.
  <https://github.com/danylaksono/screengrid> — shares the screen-space
  parameterisation and canvas-overlay architecture used here.
