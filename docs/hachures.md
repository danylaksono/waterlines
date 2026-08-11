# Hachured relief on an interactive map

_Generating Lehmann hachures from a terrain-RGB tile source in screen space,
and the scale problem that makes it different from generating them once_

This document records the method used for the hachure layer in
[`/studio`](../studio/index.html): where the surface comes from, how the strokes
are placed, how the drawing rules of the engraved tradition are applied, the
measurements that drove each decision, and the several approaches that were
tried and abandoned. It is a companion to [`methodology.md`](methodology.md),
which covers the waterlines; the two subsystems share a coordinate system, a
caching strategy and a compositing order, and nothing else.

For user documentation see the [README](../README.md).

> **On the references.** Citations are given with enough detail to locate the
> source. Where a claim rests on a secondary summary rather than on the original
> it is marked **[unverified]** in place, and §10 lists what would have to be
> checked before publication. The quantitative statements about _this
> implementation_ are all measured and are reproducible by §11.

---

## 1. Scope and claim

**Hachures** are short strokes drawn down the line of steepest descent, whose
thickness grows with the gradient. They were the dominant means of depicting
relief on European topographic maps for most of the nineteenth century, before
contours displaced them. Unlike hillshading they encode slope rather than
illumination, and unlike contours they read as texture at a glance without
being traced.

The system implemented here is Lehmann's (1799) [L1] **[unverified]**: constant
spacing, with the ratio of ink to white proportional to slope, nothing drawn
below 5°, and solid black at 45°.

The contribution is not the visual effect, and not the streamline placement —
both are prior art (§2.2). It is the **scale handling**. A hachure map is
normally generated once, for one sheet, at one scale. On a map that zooms, the
quantity the whole technique is built on — slope — is not a property of the
terrain alone but of the terrain _and the baseline it is measured over_, and
that baseline changes with every zoom level. Two claims follow.

> **H1.** Measured slope falls off systematically as the map zooms out, at a
> rate characteristic of the terrain rather than of the sampling: on the test
> volcano, the 75th-percentile slope over land falls by a factor of 16 between
> 28 m and 3.6 km per sample, fitting $s \propto L^{-0.585}$.
>
> **H2.** Undoing that falloff by scaling heights — a vertical exaggeration that
> grows with the map scale — holds the slope statistic the ink is derived from
> within a factor of 1.4 across the same range, against 15.9 uncorrected. It is
> the difference between a small-scale sheet that reads as relief and one that
> reads as scattered blemishes.

§5 gives the measurements supporting both. §9 states what neither claims.

A second, smaller claim concerns fidelity to the source tradition:

> **H3.** Lehmann's numeric limits are load-bearing rather than decorative.
> Substituting a solid-black angle fitted to the steepest ground in view — the
> intuitive choice, and the one made here first — inflates ink coverage on a
> fixed view from 0.76% to 2.01%, a factor of 2.6, with nothing else changed.

---

## 2. Background

### 2.1 Cartographic

Lehmann, an officer in the Saxon service, published his system in 1799 as an
aid to rapid military survey [L1] **[unverified]**. Its content is a rule
converting a measured slope into a ratio of black to white on the page, applied
to strokes that follow the fall line and are arranged in rows. The secondary
literature consulted here [ICA1] gives the operative limits: hachures are
omitted below 5°, the representable range runs to 45°, thicknesses fall into
eight classes, a stroke is at most 4 mm long and never shorter than the gap to
its neighbour.

Those last two constraints are worth stating separately from the ink rule,
because they are what make a field of strokes read as _drawn_. §8.6 records
what happens when the short bound is relaxed.

Imhof [I1] is the standard modern treatment of relief depiction and is the
reference for what hachures give up relative to shading — chiefly that they
carry no illumination and therefore no impression of form beyond slope
magnitude.

### 2.2 Computational

Automated hachuring from elevation models is not new; Kennelly [K1] gives a
desktop-GIS treatment and states the two rules this implementation also follows
— derive direction from aspect, vary density and thickness with slope angle.

The placement problem — covering a domain with streamlines that are evenly
spaced rather than merely numerous — is Jobard & Lefebvre's [J1]. Their
algorithm seeds a new streamline at a fixed offset from an existing one and
terminates integration when it approaches any already placed. This
implementation uses their termination rule and their occupancy structure but
**not** their seeding order; see §4.3.

The distance transform used by a withdrawn variant (§8.8) is Felzenszwalb &
Huttenlocher's [F1].

---

## 3. Problem statement

Given a viewport on a Web Mercator map, produce a raster of hachures over the
land in view such that:

- **P1.** Stroke direction is the projected direction of steepest descent.
- **P2.** Ink density at a point is a stated function of the true ground slope
  there, with the metre scale correct for the latitude.
- **P3.** Strokes are arranged in rows that align across a hillside.
- **P4.** The picture is stable under panning and rotation, and its character
  does not change with zoom.
- **P5.** The cost is compatible with an interactive map — that is, the map does
  not wait for it.

**P4** is the one that is not obviously hard, and it is the one that took the
most work. Its second half is the subject of §5.

---

## 4. Method

### 4.1 The height field is screen-aligned

Elevation is fetched as terrain-RGB tiles in Mapzen's `terrarium` encoding,

$$
h = 256 R + G + \tfrac{1}{256} B - 32768 \ \ \text{metres},
$$

from the Terrain Tiles collection on AWS Open Data [T1], and resampled onto a
lattice of samples every `STEP = 3` CSS pixels across the viewport plus a
`PAD = 128` px margin.

Sampling on a **screen-aligned** lattice rather than in tile space is the single
decision that most simplifies everything downstream. The gradient of a
screen-aligned grid is already a screen-space gradient, so **P1** requires no
special handling of the map's bearing: rotate the map and the fall lines rotate
with it, because the lattice did. Nothing in §4.3–§4.6 ever refers to a
projection.

Two properties of this particular dataset are load-bearing rather than
incidental:

- It is served with `Access-Control-Allow-Origin: *`, so tiles can be drawn into
  a canvas and read back with `getImageData` **without tainting it** — which is
  what would otherwise break the PNG export, three modules away.
- It carries bathymetry, so ocean is genuinely negative rather than a nodata
  sentinel. Testing $h > 0$ therefore yields a coastline for free, and the
  hachures stop exactly where the waterlines begin.

The DEM level is chosen so one DEM pixel lands on roughly one sample. A map
world is $512 \cdot 2^{z}$ px across and a 256-px-tile DEM world is
$256 \cdot 2^{z'}$, so

$$
z' = \operatorname{round}\!\left(z + 1 - \log_2 \texttt{STEP}\right),
$$

clamped to $[0, 15]$, then reduced further while the covering tile count exceeds
48. A typical view fetches 8–15 tiles.

The metre scale comes from

$$
\texttt{groundStep} = \frac{\texttt{STEP}}{512 \cdot 2^{z}} \cdot C \cos\varphi,
$$

$C$ the equatorial circumference. The $\cos\varphi$ is what stops Mercator's
vertical stretch from reading as gentler terrain at high latitude, and is
required by **P2**.

### 4.2 Generalisation

Two passes of a separable box blur, radius configurable, default 2 samples.

This is not a nicety and not an optimisation. Traced raw, a 30 m DEM produces
frizzy, insect-leg strokes that follow every artefact in the source; the
engraved look is a property of a _generalised_ surface. Of the steps in this
pipeline it is the one whose removal is most immediately visible.

### 4.3 Evenly-spaced fall lines

Gradient and slope are computed by central differences over the whole grid.
Downhill in screen axes is simply $-(g_x, g_y)$, since the lattice's $j$ axis
increases downward.

Streamlines are integrated by midpoint (RK2) at a step of 0.5 samples.
Euler alone visibly cuts corners on a ridge, which shows as strokes drifting off
the fall line. Integration from a seed runs **both** ways — uphill and downhill —
and the two halves are joined, so a stroke is cut from the whole fall line
through the seed rather than starting at it.

Termination, in the order tested: leaving the grid; reaching $h \le 0$ (sea);
slope below a hysteresis floor of $0.55 \times$ the seeding threshold; a
reversal of direction, which means the line has walked into a pit or over a
summit where the gradient is undefined and the integrator would otherwise
oscillate in place; and approach within $0.92\,d_\text{sep}$ of a line already
placed, tested against a uniform bucket grid of cell size $d_\text{sep}$ so the
query is nine short array scans [J1].

The hysteresis matters: without it, fall lines end at a ragged contour of the
seeding threshold rather than where the hill does.

**Seeding order is a deliberate departure from [J1].** Rather than seeding at an
offset from the previous streamline, candidates are all lattice points above the
slope threshold, consumed in descending order of slope. The ordering is done by
bucketing into 24 classes rather than sorting — a full sort of a couple of
hundred thousand samples costs more than everything else in the file put
together, and only the coarse order matters. Within a bucket the walk strides by
a number coprime to the bucket size, because consuming a bucket in raster order
fills the top-left of the screen first and the spacing rule then biases the whole
picture.

The motive is that ink is a budget: steepest-first spends it on the ground that
earns it under Lehmann's rule.

### 4.4 Rows are cut at contours

Each fall line is cut wherever it crosses a multiple of the contour interval.

This is the step that produces **P3**, and it produces it without any explicit
alignment pass: every stroke on a hillside breaks at the same elevations, so the
rows line up because the terrain says so. Nothing anywhere in the code compares
one stroke to another for alignment.

Each piece is then trimmed back from both crossings by
$\min(0.35\,d_\text{sep},\ 0.22\,\ell)$ where $\ell$ is the piece length,
rounded **down** to a whole integration step. The proportional term and the
downward rounding are both deliberate; §8.3 records what a fixed gap does.

Pieces shorter than $d_\text{sep}$ are discarded, per [ICA1]'s lower bound on
the mark.

### 4.5 Lehmann's rule as stroke width

For a point of slope $s$ (rise over run), with $\sigma$ the spacing in CSS px
and $s_{\max} = \tan 45° = 1$,

$$
w \;=\; \sigma \cdot \operatorname{clamp}\!\left(\frac{s}{s_{\max}},\, 0.04,\, 0.9\right) \cdot \text{weight} \cdot \tau,
$$

with $\tau$ a taper running from 1 at the upper end of the stroke to 0.45 at the
lower. The clamps hold the steepest faces just short of solid — a row that
touches its neighbours loses the fall-line direction that is the whole point of
hachures over shading — and allow the tails that ran on past the seeding
threshold (§4.3) to go very fine.

Because $w \propto \sigma$, **halving the spacing halves the strokes**: the
texture gets finer without getting lighter. This is a property of Lehmann's rule
and it is not obvious from the control panel, so the UI says so.

Strokes are outlined as polygons and filled, rather than stroked with a
`lineWidth`. Stroking cannot vary width _within_ a stroke, and the wedge is a
large part of what separates hachures from hatching.

The **direction** of the taper is not settled by the sources consulted (§10).
The implementation puts the weight at the upper end on a structural argument
rather than a historical one: it darkens the same elevation across a whole
hillside, reinforcing the contour banding of §4.4. The difference on screen is
subtle at any spacing one would actually use.

### 4.6 The contour interval is a screen-space quantity

The interval is not chosen from the relief. It is chosen so that rows come out a
wanted length **on screen**, and then rounded to a figure a surveyor would have
picked (1, 2, 2.5 or 5 times a power of ten).

Contours lie $\Delta h / s$ apart on the ground and hence
$\Delta h / (s \cdot m)$ px apart on screen, $m$ the metres per pixel. Inverting,

$$
\Delta h \;=\; \operatorname{snap}\!\left(\ell_\text{row} \cdot m \cdot s_{75}\right),
$$

where $s_{75}$ is the 75th percentile of slope over hachured ground, taken from
a 256-bin histogram.

Both the inversion and the choice of percentile are corrections to earlier
attempts; §8.1 and §8.2 record what they replaced.

### 4.7 Rasterisation, caching and compositing

Strokes are filled in batches of `FILL_BATCH = 128` subpaths. The batch size is
measured, not chosen; §8.5.

The layer owns a 2D canvas in MapLibre's canvas container, inserted **before**
the waterlines canvas so the relief sits under the ripples. A renderer swap
re-appends the waterlines canvas at the end of the container, so that ordering
survives one without special handling.

The bitmap is rebuilt when the view settles (140 ms debounce) and merely
transformed while the view moves, reusing `blitTransform` from the waterlines'
own raster cache — so the two bitmaps slide in exact agreement under pan, zoom
and rotation. This is **P5**: the map never waits.

The PNG export composites the hachure canvas between the basemap and the
waterlines. Above 1×, it is **retraced** at the grown container size rather than
upscaled, since a stroke traced for the smaller view would export as a soft,
over-thick one.

---

## 5. Scale dependence and vertical exaggeration

This section supports **H1** and **H2**.

### 5.1 The observation

Slope is a ratio measured over a baseline, and zooming out grows the baseline.
The 75th-percentile slope over land, measured on Rinjani (Lombok) at eight zoom
levels through the pipeline of §4.1–§4.3:

| metres/sample | p50 | p75 |
| --- | --- | --- |
| 28 | 21.0° | 30.2° |
| 57 | 12.6° | 22.1° |
| 113 | 5.3° | 12.7° |
| 227 | 4.3° | 10.8° |
| 454 | 3.8° | 7.8° |
| 907 | 2.8° | 5.5° |
| 1815 | 1.5° | 3.1° |
| 3630 | 0.6° | 1.9° |

The same ground, sixteen times gentler. **Nothing has been lost**: the gentle
figure is correct — at 1.8 km per sample the flanks of a 3,700 m volcano really
do average 3°. Fetching a finer DEM does not help, because it would be averaged
into the same samples.

But 3° is flat ground under Lehmann's 5° threshold, and the tracer rightly
refuses to ink it. The result is a small-scale sheet carrying a scatter of
hairlines on a few steep slivers, which was the reported defect that prompted
this section.

The ratio between successive rows is about 1.5 per halving of the baseline,
i.e. $s \propto L^{-0.585}$ — the fractal signature of real terrain, and
consistent with a Hurst exponent around 0.4.

### 5.2 The correction

The answer is not to recover detail but to **exaggerate**, which is what an
engraver did on a small-scale sheet and what a physical relief model still does.
Heights are multiplied by

$$
E(L) \;=\; \left(\frac{L}{L_0}\right)^{0.585}, \qquad L_0 = 60\ \text{m},
$$

$L_0$ being the sample spacing near zoom 12, where the stroke parameters were
calibrated. $E < 1$ below $L_0$, which keeps a zoomed-right-in sheet from
blocking in.

Applying it to the table above holds the corrected p75 between 18.1° and 25.2°
across the whole range — a spread of 1.39 against 15.9 uncorrected.

Three consequences worth recording:

1. **It is applied to heights, not to thresholds.** These are equivalent for the
   ink rule but not for §4.6: the interval is linear in slope, so scaling
   heights scales the interval identically and the row length on screen does not
   move. Lowering the thresholds instead would have required a second correction.
2. **It applies to measured terrain only.** The invented surface of §6 is built
   to a stated steepness _through the map scale_ and is therefore
   scale-invariant by construction; exaggerating it would break that.
3. **It is stated, not hidden.** The status line reports the factor, and the
   relief it quotes is always the ground's, never the drawing's. A control turns
   it off for true slopes.

### 5.3 Ink density across zoom

With §5.2 in force and the defaults of §4.5, ink coverage over the full canvas
(sea included) on a fixed centre:

| zoom | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ink | 0.24% | 0.40% | 0.50% | 0.56% | 0.82% | 1.30% | 1.57% | 2.04% | 1.75% |
| $E$ | 24.8 | 16.5 | 11.0 | 7.3 | 4.9 | 3.3 | 2.2 | 1.5 | 1.0 |

The broadly upward trend is expected and wanted, and is not what §5.2 corrects:
zooming into an island simply puts more land on screen, and at zoom 4 most of
the canvas is sea. What §5.2 removes is the trend in ink _per unit of hachured
land_. The dip at zoom 12 is the exaggeration passing through 1 while the view
fills with land — the two effects are independent and need not cancel neatly.

---

## 6. The invented surface

A second relief source keeps the summit **positions** from the DEM and discards
the shape, redrawing each as an idealised hill. This is closer to how relief was
drawn before contour surveying — the mountains are where the mountains are, and
each is a symbol — and it generalises far harder than any amount of blurring,
which is what lets it hold up at scales where real terrain turns to mush.

Summits are local maxima under a window maximum, found in two stages: block
maxima first, leaving a few hundred candidates, then the full window test on
those alone. The answer is identical to the direct test and the work is three
orders of magnitude smaller. Using a window maximum also spaces the summits for
free.

Each hill is a smoothstep profile — zero slope at summit and base, steepest at
the waist. A cone is the obvious choice and is wrong: constant slope gives every
stroke the same width and the hill reads as a flat disc of texture. The
mid-profile maximum gives each mound a dark band at its waist with a bare summit
and a bare skirt, which is how an engraved hill is built, and here it falls out
of the surface rather than being drawn in.

Hills combine by **maximum**, not by sum. Summing merges neighbours into one
swollen massif and loses the individual summits, which are the only real
information in the picture.

Summits are sought at **half** the mound radius, so neighbouring hills overlap
and merge into ranges; §8.7 records what the full radius does.

The source will also accept a supplied summit list, at which point it makes no
network request at all. That is the seam for a precomputed extract — an
H3-indexed terrain aggregate [W1] can apply a real prominence test over a whole
country, which a window maximum over one screenful cannot.

---

## 7. Measured cost

One configuration, stated in full because the figures move a great deal with
viewport area and stroke count: 1920×1009 CSS px, Rinjani at zoom 11, defaults
of §4.5, tile cache warm, 8,869 strokes emitted. Headless Chromium with GPU
rasterisation.

| stage | ms |
| --- | --- |
| DEM resample and stitch, tiles cached | 287 |
| Generalise, differentiate, trace, cut | 326 |
| Rasterise, forced to flush | 425 |
| **end-to-end rebuild, median of 5** | **752** |

The end-to-end figure is lower than the sum because the staged measurement pays
for a fresh canvas allocation and an extra copy of the height field that the
real path does not; where they disagree, the end-to-end figure is the honest
one. Run-to-run spread was 709–782 ms.

The cost tracks the number of strokes, which tracks hachured area. At the same
viewport and settings but zoom 9, where much of the canvas is sea, 4,726 strokes
rebuild in 511 ms (median of 5, spread 503–601). Cutting the spacing in half
roughly doubles the stroke count and the cost with it.

None of it is on the interaction path. The rebuild is debounced 140 ms behind
the map settling, and panning, zooming and rotating cost a CSS matrix (§4.7).

---

## 8. Negative results

The value of this section is that every entry below produced a picture that
rendered without error and looked plausible at a glance.

### 8.1 Choosing the contour interval from the relief

The first implementation divided the relief in view into a fixed number of
bands. This is the obvious reading and it is wrong, because how far apart two
contours land on _paper_ depends on the slope between them and on the map scale,
neither of which the relief knows about. On a 20° flank at 130 m/px, a 100 m
interval puts its rows two pixels apart, and the hachures came out as stipple.
Replaced by the inversion of §4.6.

### 8.2 Sizing the interval on the median slope

Having inverted the relationship, the natural statistic is the median. Also
wrong, and wrong in the direction that matters: row length runs as
$\Delta h / s$, so one interval cannot suit both a cliff and a plain. Sized on
the median, the steep ground — where nearly all the strokes are, and where the
eye goes — is cut into specks, while the plains get tidy rows nobody looks at.
The 75th percentile sizes for the ground that makes the picture; gentle ground
then draws long strokes, which is what a long fall line down a gentle slope
should look like.

### 8.3 A fixed row gap

Trimming a fixed width from each end of every row inverts Lehmann's rule
exactly where it matters. Steep ground crowds its contours together, so a fixed
gap eats a short row entirely, and the steepest face on the map — which should
be nearly solid — becomes the palest part of it. The gap is now proportional to
the row, and rounds down to nothing rather than up to one step.

### 8.4 A slope-to-ink mapping fitted to the view

Setting the solid-black angle near the steepest ground actually present — 20°,
against Lehmann's 45° — doubles the ink on every hillside. Ink coverage on one
fixed view:

| | coverage |
| --- | --- |
| original defaults, ceiling 20° | 2.01% |
| ceiling moved to 45°, nothing else changed | 0.76% |
| full current defaults (finer spacing adds strokes back) | 1.03% |

This surfaced as a report from use — relief that "looks too thick and dominant"
when zoomed out — and had already been worked around by the reporter, who
lowered the ink control to 60%. That recovers $0.78 \times 0.6 = 0.47$ against
Lehmann's $20/45 = 0.44$ at the slope in question: the historical ratio had been
found by eye before it was looked up. It is the strongest evidence in this
document that the 1799 numbers are not arbitrary.

### 8.5 One path, one fill

The initial rasteriser put every stroke into a single path and filled once, on
the reasoning that one rasterisation beats twenty thousand. The rasteriser's
edge list is superlinear in the size of a single path, so this is the worst
available choice. Measured on 5,653 strokes at 1696×1156:

| subpaths per `fill()` | 1 | 8 | 32 | 128 | 500 | all |
| --- | --- | --- | --- | --- | --- | --- |
| ms | 223 | 494 | 259 | **140** | 198 | 1821 |

The curve has an interior minimum because per-call overhead and per-path edge
cost pull opposite ways. Batching at 128 is a 13× speedup over the "obvious"
formulation.

### 8.6 Allowing strokes shorter than the spacing

The minimum stroke length was initially $0.6\,d_\text{sep}$. [ICA1] gives the
lower bound as the spacing itself, and the difference is visible: below it, the
field acquires a population of stubby marks that read as specks rather than
strokes, and specks are a large part of what makes generated hachures look
unlike drawn ones.

### 8.7 Spacing summits at the mound radius

For §6, searching for summits at the same radius as the drawn hill leaves every
hill standing alone. A page of isolated, radially symmetric mounds reads as a
scatter of rosettes rather than as mountains. Halving the search radius lets
neighbours overlap and merge into ranges.

### 8.8 A distance-to-coast surrogate for terrain

A third relief source was implemented and later withdrawn. It derived a surface
from the distance inland from the loaded coastline — no elevation data at all —
on the reasoning that a seventeenth-century engraver had no better information
either, and that the machinery was already present.

It is recorded here for two findings rather than for the feature.

**The saturating profile was wrong.** A profile of $1 - e^{-d/r}$ flattens a
fixed distance inland; measured on Lombok it left 90% of the island below the
flat-ground threshold, so the hachures clung to the beach and the interior was
blank. A power below one, $(1 + d/r)^{p}$ with $p = 0.55$, keeps some slope
everywhere while still easing off, and took coverage from 10% to 100% of land.

**`Infinity` breaks the distance transform.** [F1]'s parabola intersection
subtracts one cost from another, so seeding absent cells with `Infinity` yields
`Infinity - Infinity` $=$ `NaN`; every comparison against `NaN` is false, the
algorithm silently keeps the wrong parabola, and it returns distances that are
not imprecise but arbitrary. It presented as an invented coastline forty times
steeper than the one requested. A large finite sentinel fixes it. This is a
general hazard for any use of [F1] and is the reason it is recorded despite the
feature being gone.

The source was withdrawn on the assessment that it did not earn its place: it
produced a near-uniform slope everywhere, hence near-uniform stroke weight,
hence a woven texture rather than relief.

---

## 9. Limitations

- **Pitch.** Inherited from the overlay architecture: a tilted view is
  projective, and the screen-aligned lattice of §4.1 assumes an affine map.
  Bearing is handled; pitch is not.
- **The exponent of §5.2 is fitted to one mountain.** 0.585 comes from eight
  measurements on a single volcanic cone. It is consistent with the fractal
  behaviour of terrain generally, but a mature drainage basin or a fold belt
  would very likely give a different exponent, and no attempt has been made to
  measure one. Estimating it per view — the field is already in memory at two
  effective resolutions on any zoom change — is possible and is not implemented.
- **One DEM provider.** The layer depends on a single public tile collection
  [T1]. It has no fallback, and no cached copy.
- **Mounds are radially symmetric.** §6 produces circular symbols. Breaking the
  symmetry needs a view-stable seed, which the sample-space peak positions do
  not provide; elongating along the local ridge direction via a structure tensor
  would work and is not implemented.
- **Taper direction is unsourced.** §4.5.
- **No claim of morphometric validity.** The output is a drawing. The
  exaggeration of §5.2 is deliberately _not_ a faithful representation of slope,
  and the ink density on a small-scale sheet should not be read as a slope
  measurement.

---

## 10. What to verify before publication

- **[L1]** is cited from secondary summaries only. The primary source —
  Lehmann's 1799 _Darstellung einer neuen Theorie der Bezeichnung der schiefen
  Flächen_ — has not been consulted here, and the class count (eight), the
  4 mm bound and the 5°/45° limits all come through [ICA1]. The ink-to-slope
  proportionality is stated consistently across the secondary literature but the
  exact tabulation should be taken from the original.
- **Which end of a hachure carries the weight** is not established by any source
  consulted. §4.5 states the implementation's choice and its reasoning.
- Prior computer-generated hachure work predating [K1] exists and has not been
  surveyed; a literature search before publication is advisable.

---

## 11. Reproducibility

The measurements in §5.1, §5.3, §7 and §8.5 were taken in a headless Chromium at
1920×1009 against the live studio page, by importing the modules directly and
calling them with a matrix from `affineFromMap`. Each is reproducible from the
browser console on [`/studio`](../studio/index.html); `window.__waterlinesStudio`
exposes the map, the overlay and the hachure handle, and
`hachures.getStats()` reports strokes, contour interval, true relief,
exaggeration factor, DEM level and tile count for the current view.

The scale arithmetic is unit-tested without a browser in
[`tests/run-tests.mjs`](../tests/run-tests.mjs) — `npm test`. The slope table of
§5.1 is committed there as a fixture, so a change to the exaggeration law has to
answer to the observation rather than to taste. Lehmann's limits are asserted
directly, so the ceiling of §8.4 cannot silently return.

---

## References

**Primary tradition**

- **[L1]** Lehmann, J.G. (1799). _Darstellung einer neuen Theorie der
  Bezeichnung der schiefen Flächen im Grundriß oder Situationszeichnung der
  Berge._ Leipzig. **[unverified — cited via [ICA1]; see §10]**
- **[ICA1]** _J. G. Lehmann's system of slope hachures._ Proceedings of the 26th
  International Cartographic Conference, Dresden, 2013.
  <https://icaci.org/files/documents/ICC_proceedings/ICC2013/_extendedAbstract/265_proceeding.pdf>
  — source for the 5°/45° limits, the eight thickness classes, and the length
  bounds used in §4.4 and §8.6.
- **[I1]** Imhof, E. (1982). _Cartographic Relief Presentation._ Walter de
  Gruyter. (English edition; originally _Kartographische Geländedarstellung_,
  1965.)

**Automated hachuring and streamline placement**

- **[K1]** Kennelly, P.J. _Desktop Hachure Maps from Digital Elevation Models._
  <https://mbmg.mtech.edu/pdf/gis_hachuretxt.pdf>
- **[J1]** Jobard, B. & Lefebvre, W. (1997). Creating evenly-spaced streamlines
  of arbitrary density. In _Visualization in Scientific Computing '97_,
  Springer, 43–55.
- **[F1]** Felzenszwalb, P.F. & Huttenlocher, D.P. (2012). Distance transforms
  of sampled functions. _Theory of Computing_, 8(1), 415–428.

**Data**

- **[T1]** _Terrain Tiles._ AWS Open Data / Mapzen `terrarium` encoding.
  <https://registry.opendata.aws/terrain-tiles/> — SRTM, NED and others; the
  source used by §4.1.
- **[W1]** walkthru.earth. _DEM-Terrain._ Source Cooperative. GEDTM-30m
  aggregated to H3 resolutions 1–10 with `elev`, `slope`, `aspect`, `tri`, `tpi`.
  <https://source.coop/walkthru-earth/dem-terrain> — the supplied-summit path of
  §6. CC BY 4.0.

**Companion**

- [`methodology.md`](methodology.md) — the waterlines, whose coordinate system
  (§4.4 there), raster cache (§4.7 there) and compositing order this layer
  reuses.
