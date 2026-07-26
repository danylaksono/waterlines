/**
 * deckgl.js
 *
 * `WaterlinesDeckOverlay` - the same engine driven by a deck.gl viewport.
 *
 * deck.gl has no 2D-canvas layer type, and reimplementing the technique in
 * WebGL would mean giving up `destination-out` compositing, which is the
 * whole trick. So the waterlines stay on their own 2D canvas, stacked over
 * deck's canvas and synchronised from `onViewStateChange` / `onAfterRender`.
 *
 * @example
 * const overlay = new WaterlinesDeckOverlay({
 *   container: document.getElementById('deck-container'),
 *   data: land,
 *   style: { preset: 'nautical' },
 * });
 *
 * new Deck({
 *   // ...
 *   onViewStateChange: ({ viewState, interactionState }) => {
 *     overlay.sync(viewState, { moving: interactionState.isDragging ||
 *                                       interactionState.isZooming });
 *   },
 *   onAfterRender: ({ deck }) => overlay.syncViewport(deck.getViewports()[0]),
 * });
 */

import { WaterlineEngine } from '../render/WaterlineEngine.js';
import { latToMercatorY, lngToMercatorX, worldSize } from '../core/mercator.js';
import { affineEquals, affineFromViewport, solve } from './transform.js';

export class WaterlinesDeckOverlay {
  /**
   * @param {import('../render/WaterlineEngine.js').EngineOptions} options
   *   `container` should be the positioned element deck's canvas lives in.
   */
  constructor(options = {}) {
    this.engine = new WaterlineEngine(options);
    this._container = options.container;
    this._matrix = null;
    this.syncSize();
  }

  /** Re-read the container size. Call from a `ResizeObserver`. */
  syncSize() {
    this.engine.resize(this._container.clientWidth, this._container.clientHeight);
    return this;
  }

  /**
   * Draw from a deck.gl `WebMercatorViewport` (the precise path - it carries
   * the exact projection deck used for the frame).
   *
   * @param {Object} viewport
   * @param {{moving?:boolean}} [frame]
   */
  syncViewport(viewport, frame = {}) {
    if (!viewport) return this;
    if (viewport.width !== this.engine.width || viewport.height !== this.engine.height) {
      this.engine.resize(viewport.width, viewport.height);
    }
    return this._draw(affineFromViewport(viewport), frame);
  }

  /**
   * Draw from a plain view state, for hosts that do not expose a viewport.
   * Requires `@deck.gl/core`'s convention: zoom 0 == 512 px world.
   *
   * @param {{longitude:number, latitude:number, zoom:number, bearing?:number}} viewState
   * @param {{moving?:boolean}} [frame]
   */
  sync(viewState, frame = {}) {
    const { longitude, latitude, zoom, bearing = 0 } = viewState;
    const width = this.engine.width;
    const height = this.engine.height;
    const scale = worldSize(zoom);
    const rad = (bearing * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const cx = lngToMercatorX(longitude);
    const cy = latToMercatorY(latitude);

    // Reproduce deck's projection by hand - rotate by -bearing about the view
    // centre, then scale - so this path needs no deck.gl import.
    const matrix = solve(longitude, latitude, zoom, (lng, lat) => {
      const dx = (lngToMercatorX(lng) - cx) * scale;
      const dy = (latToMercatorY(lat) - cy) * scale;
      return [width / 2 + dx * cos + dy * sin, height / 2 - dx * sin + dy * cos];
    });
    return this._draw(matrix, frame);
  }

  /** @param {Partial<import('../render/style.js').WaterlineStyle> & {preset?:string}} style */
  setStyle(style) {
    this.engine.setStyle(style);
    this._matrix = null;
    return this;
  }

  /** @param {Object|import('../core/rings.js').Ring[]} data */
  setData(data) {
    this.engine.setData(data);
    this._matrix = null;
    return this;
  }

  /** @param {boolean} value */
  setVisible(value) {
    this.engine.setVisible(value);
    return this;
  }

  /** Latest frame diagnostics. */
  getStats() {
    return this.engine.getStats();
  }

  /** Detach and free. */
  remove() {
    this.engine.destroy();
    this.engine = null;
  }

  _draw(matrix, frame) {
    // Redraw when the view moved, or when the engine still wants frames - a
    // refresh in flight, or a draft bitmap waiting to be refined. That second
    // case is easy to forget, and without it the overlay stalls half-finished
    // the moment the view goes still.
    if (!this.engine.isBusy && affineEquals(matrix, this._matrix)) return this;
    this.engine.render(matrix, frame);
    this._matrix = matrix;
    return this;
  }
}
