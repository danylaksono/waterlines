/**
 * maplibre.js
 *
 * `WaterlinesOverlay` - binds a {@link WaterlineEngine} to a MapLibre GL map.
 * Also works with Mapbox GL JS: only `project`, `getCenter`, `getZoom`,
 * `getCanvasContainer`, `triggerRepaint` and the standard events are used.
 *
 * The overlay draws from inside MapLibre's own `render` event, so the
 * waterlines and the basemap are composited in the same browser frame - no
 * visible lag between a coastline and its ripples.
 *
 * @example
 * const overlay = new WaterlinesOverlay(map, {
 *   data: await (await fetch('data/indonesia-land.geojson')).json(),
 *   style: { preset: 'antique' },
 * });
 */

import { WaterlineEngine } from '../render/WaterlineEngine.js';
import { affineEquals, affineFromMap } from './transform.js';

export class WaterlinesOverlay {
  /**
   * @param {Object} map MapLibre GL map instance
   * @param {import('../render/WaterlineEngine.js').EngineOptions} [options]
   *   (minus `container`, which is taken from the map)
   */
  constructor(map, options = {}) {
    if (!map) throw new Error('WaterlinesOverlay requires a map instance');
    this.map = map;

    // MapLibre's canvas container sits below the control container, so
    // controls, popups and markers keep working and stay on top.
    const container = map.getCanvasContainer
      ? map.getCanvasContainer()
      : map.getContainer();

    this.engine = new WaterlineEngine({
      ...options,
      container,
      onInvalidate: () => map.triggerRepaint(),
    });

    this._container = container;
    this._matrix = null;
    this._syncSize();
    this._bind();
    map.triggerRepaint();
  }

  // ------------------------------------------------------------------------
  // delegation
  // ------------------------------------------------------------------------

  /** @param {Object|import('../core/rings.js').Ring[]} data */
  setData(data) {
    this.engine.setData(data);
    return this._refresh();
  }

  /** @param {Partial<import('../render/style.js').WaterlineStyle> & {preset?:string}} style */
  setStyle(style) {
    this.engine.setStyle(style);
    return this._refresh();
  }

  /** @param {Object} lod */
  setLodOptions(lod) {
    this.engine.setLodOptions(lod);
    return this._refresh();
  }

  /** @param {boolean} value */
  setVisible(value) {
    this.engine.setVisible(value);
    return this._refresh();
  }

  /**
   * Animate the waterlines. See {@link import('../render/WaterlineEngine.js').WaterlineEngine#setAnimation}
   * for what it costs.
   *
   * @param {Object|null} animation
   */
  setAnimation(animation) {
    this.engine.setAnimation(animation);
    return this._refresh();
  }

  /** Latest frame diagnostics. */
  getStats() {
    return this.engine.getStats();
  }

  /** Force a redraw on the next map frame. */
  redraw() {
    return this._refresh();
  }

  /** Detach from the map and remove the canvas. */
  remove() {
    this._unbind();
    this.engine.destroy();
    this.engine = null;
  }

  // ------------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------------

  _refresh() {
    this.engine.invalidate();
    this._matrix = null;
    this.map.triggerRepaint();
    return this;
  }

  _bind() {
    this._onRender = () => this._frame();
    this._onResize = () => {
      this._syncSize();
      this._refresh();
    };
    // Once the view settles, redraw at full resolution and at the LOD that
    // actually matches the zoom.
    this._onSettle = () => this._refresh();

    this.map.on('render', this._onRender);
    this.map.on('resize', this._onResize);
    this.map.on('moveend', this._onSettle);
    this.map.on('zoomend', this._onSettle);
    this.map.on('rotateend', this._onSettle);
  }

  _unbind() {
    this.map.off('render', this._onRender);
    this.map.off('resize', this._onResize);
    this.map.off('moveend', this._onSettle);
    this.map.off('zoomend', this._onSettle);
    this.map.off('rotateend', this._onSettle);
  }

  /**
   * Size comes from the GL canvas, not from the container: MapLibre's canvas
   * container is absolutely positioned and reports `clientHeight === 0`, and
   * the GL canvas is by definition the rectangle `map.project` maps into.
   */
  _syncSize() {
    const canvas = this.map.getCanvas();
    this.engine.resize(canvas.clientWidth, canvas.clientHeight);
  }

  _isMoving() {
    const map = this.map;
    return !!(
      (map.isMoving && map.isMoving()) ||
      (map.isZooming && map.isZooming()) ||
      (map.isRotating && map.isRotating()) ||
      (map.isEasing && map.isEasing())
    );
  }

  _frame() {
    if (!this.engine) return;
    if (this.map.getCanvas().clientWidth !== this.engine.width) this._syncSize();

    const matrix = affineFromMap(this.map);
    if (!this.engine.isBusy && affineEquals(matrix, this._matrix)) return;

    this.engine.render(matrix, { moving: this._isMoving() });
    this._matrix = matrix;

    // A background refresh only advances on the frames it is given, and
    // MapLibre stops drawing once the map is idle - so ask for the next one.
    if (this.engine.isBusy) this.map.triggerRepaint();
  }
}

/**
 * Convenience factory.
 *
 * @param {Object} map
 * @param {import('../render/WaterlineEngine.js').EngineOptions} options
 * @returns {WaterlinesOverlay}
 */
export function addWaterlines(map, options) {
  return new WaterlinesOverlay(map, options);
}
