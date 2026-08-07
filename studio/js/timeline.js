/**
 * timeline.js
 *
 * A year slider for the OpenHistoricalMap basemap, docked over the map rather
 * than in the side panel - it only applies to one basemap, and a control that
 * appears and disappears reads better floating than as a panel section that
 * keeps collapsing.
 *
 * How the filtering works, since it is not obvious: OHM does **not** take a
 * date parameter in its tile URLs. Every tile carries the features of all
 * history at once, each tagged with `start_date` / `end_date`, and the map
 * library filters them client-side. Without a filter you see every period
 * superimposed. `@openhistoricalmap/maplibre-gl-dates` does the filtering:
 * loaded as a plain script after MapLibre, it patches
 * `maplibregl.Map.prototype.filterByDate`, which rewrites the filter of every
 * layer that has a `source-layer`.
 *
 * Two consequences worth knowing:
 *
 *  - Only vector layers are touched. The waterlines are a separate canvas and
 *    the studio's own GeoJSON layers have no `source-layer`, so neither is
 *    affected - which is also why the waterlines do *not* travel in time. They
 *    are drawn from modern Natural Earth coastlines whatever the year says.
 *  - Filters live on the style, so a basemap switch discards them. The date
 *    has to be re-applied every time the style loads.
 */

const PLUGIN_URL =
  "https://unpkg.com/@openhistoricalmap/maplibre-gl-dates@1.3.0/index.js";

/**
 * @typedef {Object} Timeline
 * @property {(active: boolean) => void} setActive show or hide, and apply
 * @property {() => void} reapply re-filter the current style
 * @property {() => number} getYear
 * @property {(year: number) => void} setYear
 * @property {() => void} destroy
 */

/**
 * @param {Object} map MapLibre map
 * @param {HTMLElement} element container to build into
 * @param {Object} [options]
 * @param {number} [options.min=500]
 * @param {number} [options.max] defaults to the current year
 * @param {number} [options.value] defaults to `max`
 * @param {(year:number) => void} [options.onChange]
 * @returns {Timeline}
 */
export function createTimeline(map, element, options = {}) {
  const max = options.max ?? new Date().getFullYear();
  const min = options.min ?? 500;
  let year = clamp(options.value ?? max, min, max);

  element.innerHTML = `
    <div class="timeline__head">
      <span class="timeline__label">OpenHistoricalMap</span>
      <output class="timeline__year">${year}</output>
    </div>
    <input class="timeline__range" type="range"
           min="${min}" max="${max}" step="1" value="${year}"
           aria-label="Year shown on the historical basemap">
    <div class="timeline__foot">
      <span>${min}</span>
      <span class="timeline__note">basemap only &mdash; waterlines stay modern</span>
      <span>${max}</span>
    </div>
  `;

  const range = element.querySelector(".timeline__range");
  const output = element.querySelector(".timeline__year");
  const note = element.querySelector(".timeline__note");

  let active = false;
  let disabled = false;

  const onInput = () => {
    year = Number(range.value);
    output.textContent = year;
    apply();
    if (options.onChange) options.onChange(year);
  };
  range.addEventListener("input", onInput);

  let waiting = false;
  let attempts = 0;

  /**
   * Apply the current year to the current style.
   *
   * The readiness test is deliberately *not* `map.isStyleLoaded()`. That is
   * true only once every source has loaded as well, and a hosted basemap whose
   * tiles are slow, blocked or simply missing may never reach it - leaving the
   * slider permanently inert even though the style it needs to edit is right
   * there. `filterByDate` walks `getStyle().layers` and rewrites filters; all
   * it needs is the style *spec*. So that is what is waited for.
   */
  function apply() {
    if (!active || disabled) return;
    if (typeof map.filterByDate !== "function") {
      fail("date plugin unavailable");
      return;
    }

    let layers = null;
    try {
      layers = map.getStyle()?.layers;
    } catch {
      layers = null; // style mid-swap
    }
    if (!layers || !layers.length) return defer();

    try {
      map.filterByDate(String(year));
      attempts = 0;
    } catch (error) {
      // A style caught mid-construction can throw; that is worth one or two
      // more goes, but a filter that never applies should say so rather than
      // retry silently for the life of the page.
      if (++attempts < 4) return defer();
      fail(error.message);
    }
  }

  /** Try again on the next style event, without stacking up listeners. */
  function defer() {
    if (waiting) return;
    waiting = true;
    map.once("styledata", () => {
      waiting = false;
      apply();
    });
  }

  function fail(message) {
    disabled = true;
    range.disabled = true;
    note.textContent = `unavailable: ${message}`;
    element.classList.add("is-disabled");
  }

  return {
    setActive(value) {
      active = !!value;
      element.classList.toggle("is-on", active);
      if (active) apply();
    },
    reapply: apply,
    getYear: () => year,
    setYear(value) {
      year = clamp(value, min, max);
      range.value = String(year);
      output.textContent = year;
      apply();
    },
    destroy() {
      range.removeEventListener("input", onInput);
      element.innerHTML = "";
    },
  };
}

/**
 * True once the date plugin has patched MapLibre.
 *
 * The plugin is a third-party script from a CDN, and the studio has to work
 * when it does not arrive - offline, blocked, or the CDN having a bad day. The
 * caller uses this to decide whether to offer the control at all rather than
 * showing one that does nothing.
 *
 * @returns {boolean}
 */
export function datePluginLoaded() {
  return (
    typeof maplibregl !== "undefined" &&
    typeof maplibregl.Map?.prototype?.filterByDate === "function"
  );
}

export { PLUGIN_URL };

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
