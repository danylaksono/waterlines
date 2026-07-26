/**
 * hud.js
 *
 * Live performance readout. The claim this demo makes is that the map stays
 * interactive while the waterlines redraw every frame, so the numbers behind
 * that claim should be on screen rather than in a README.
 */

/**
 * @param {HTMLElement} root
 * @returns {{update:(stats:Object)=>void, tick:()=>void}}
 */
export function createHud(root) {
  const rows = {
    fps: row(root, 'fps', 'frames per second, measured over the last second'),
    mode: row(
      root,
      'overlay mode',
      'blit = the cached bitmap was reused; refreshing = a new one is being rendered a few passes per frame'
    ),
    frame: row(root, 'frame interval', 'moving average of the gap between frames while dragging'),
    budget: row(
      root,
      'frame cost',
      'measured time the overlay spent on this frame, and how many render passes it managed'
    ),
    rings: row(root, 'rings drawn', 'rings surviving the viewport cull'),
    vertices: row(root, 'vertices @ lod', 'vertex count of the active level of detail'),
    lod: row(root, 'lod zoom', 'integer zoom the geometry was prepared for'),
    ratio: row(root, 'pixel ratio', 'canvas backing-store scale; drops while moving'),
  };

  let frames = 0;
  let since = performance.now();
  let fps = 0;

  return {
    /** @param {Object} stats from `overlay.getStats()` */
    update(stats) {
      rows.mode.textContent = stats.pending
        ? `refreshing ${Math.round(stats.progress * 100)}%`
        : stats.mode;
      rows.mode.className = `hud__value ${stats.pending ? 'is-warn' : 'is-ok'}`;
      rows.frame.textContent = stats.frameMs ? `${stats.frameMs.toFixed(1)} ms` : '-';
      rows.frame.className = `hud__value ${stats.frameMs > 22 ? 'is-warn' : 'is-ok'}`;
      rows.budget.textContent = `${stats.submitMs.toFixed(1)} ms / ${stats.stepsPerFrame} pass`;
      rows.budget.className = `hud__value ${stats.submitMs > 12 ? 'is-warn' : 'is-ok'}`;
      rows.rings.textContent = String(stats.rings);
      rows.vertices.textContent = `${stats.vertices.toLocaleString()} of ${(
        stats.sourceVertices || 0
      ).toLocaleString()}`;
      rows.lod.textContent = stats.lodZoom === null ? '-' : String(stats.lodZoom);
      rows.ratio.textContent = `${stats.pixelRatio}x${stats.moving ? '  (moving)' : ''}`;
    },
    /** Call once per animation frame. */
    tick() {
      frames++;
      const now = performance.now();
      if (now - since >= 1000) {
        fps = Math.round((frames * 1000) / (now - since));
        frames = 0;
        since = now;
        rows.fps.textContent = String(fps);
        rows.fps.className = `hud__value ${fps < 40 ? 'is-warn' : 'is-ok'}`;
      }
    },
  };
}

function row(root, label, title) {
  const line = document.createElement('div');
  line.className = 'hud__row';
  line.title = title;
  const key = document.createElement('span');
  key.className = 'hud__key';
  key.textContent = label;
  const value = document.createElement('span');
  value.className = 'hud__value';
  value.textContent = '-';
  line.appendChild(key);
  line.appendChild(value);
  root.appendChild(line);
  return value;
}
