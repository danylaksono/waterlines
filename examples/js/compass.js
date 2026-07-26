/**
 * compass.js
 *
 * An engraved-chart wind rose.
 *
 * Drawn with canvas rather than as SVG or DOM for the same reason the paper
 * grain is (see `paper.js`): the studio's job is producing images, and the PNG
 * export has to be able to paint the identical thing into the export canvas.
 * One drawing function, two callers.
 *
 * The rose counter-rotates with the map bearing, so its north stays true north.
 */

const TAU = Math.PI * 2;

/**
 * @typedef {Object} RoseOptions
 * @property {number} x centre, in the target context's pixels
 * @property {number} y
 * @property {number} radius outer ring radius, same units
 * @property {number} [bearing=0] map bearing in degrees; the rose turns by -bearing
 * @property {string} [ink='#5a4632']
 * @property {string} [paper='#f2e7cd'] backing disc
 * @property {string} [light='#fdf8ec'] the lit half of each point; needs to be
 *   a shade lighter than `paper` or the split does not read
 * @property {boolean} [backing=true] soft parchment disc behind the rose
 * @property {number} [opacity=1]
 */

/**
 * Paint a wind rose centred on (x, y).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {RoseOptions} options
 */
export function drawCompassRose(ctx, options) {
  const {
    x,
    y,
    radius: R,
    bearing = 0,
    ink = '#5a4632',
    paper = '#f2e7cd',
    light = '#fdf8ec',
    backing = true,
    opacity = 1,
  } = options;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(x, y);
  ctx.rotate((-bearing * Math.PI) / 180);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';

  if (backing) drawBacking(ctx, R, paper);
  drawLimb(ctx, R, ink);
  drawStar(ctx, R, ink, light);
  drawHub(ctx, R, ink, light);
  drawFleur(ctx, R, ink, light);
  drawLetters(ctx, R, ink);

  ctx.restore();
}

/**
 * Where the rose can sit. The same table drives the CSS on screen and the
 * anchor arithmetic in the export, so the two cannot drift apart — which is
 * the point, on a page whose job is producing images.
 *
 * @type {Record<string, {label:string, x:'left'|'right', y:'top'|'bottom'}>}
 */
export const PLACEMENTS = {
  'top-left': { label: 'Top left', x: 'left', y: 'top' },
  'top-right': { label: 'Top right', x: 'right', y: 'top' },
  'bottom-left': { label: 'Bottom left', x: 'left', y: 'bottom' },
  'bottom-right': { label: 'Bottom right', x: 'right', y: 'bottom' },
};

/** Half-extent of the rose's box as a multiple of its radius, allowing for the letters. */
const EXTENT = 1.34;

/**
 * Attach a rose to a map, in its own canvas, kept in step with the bearing.
 *
 * @param {Object} map MapLibre GL map
 * @param {HTMLElement} container positioned element the canvas is placed in
 * @param {Object} [options]
 * @param {number} [options.radius=62] outer ring radius in CSS px
 * @param {number} [options.inset=18] gap from the map edges in CSS px
 * @param {string} [options.placement='bottom-right'] key in {@link PLACEMENTS}
 * @param {boolean} [options.visible=true]
 * @param {string} [options.ink]
 * @param {string} [options.paper]
 * @returns {Object} handle with `setPlacement`, `setRadius`, `setVisible`,
 *   `setColors`, `paintInto`, `remove`
 */
export function createCompass(map, container, options = {}) {
  let radius = options.radius ?? 62;
  let inset = options.inset ?? 18;
  let placement = options.placement ?? 'bottom-right';
  let visible = options.visible !== false;
  let ink = options.ink ?? '#5a4632';
  let paper = options.paper ?? '#f2e7cd';

  const canvas = document.createElement('canvas');
  canvas.className = 'compass-rose';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const position = () => {
    const spot = PLACEMENTS[placement];
    if (!spot) throw new Error(`Unknown compass placement "${placement}"`);
    // Clear whichever edges are not in play, so switching corners does not
    // leave a stale offset behind.
    container.style.left = spot.x === 'left' ? `${inset}px` : '';
    container.style.right = spot.x === 'right' ? `${inset}px` : '';
    container.style.top = spot.y === 'top' ? `${inset}px` : '';
    container.style.bottom = spot.y === 'bottom' ? `${inset}px` : '';
    container.style.display = visible ? '' : 'none';
  };

  const paint = () => {
    if (!visible) return;
    const half = Math.ceil(radius * EXTENT);
    const size = half * 2;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    if (canvas.width !== size * ratio) {
      canvas.width = size * ratio;
      canvas.height = size * ratio;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size, size);
    drawCompassRose(ctx, {
      x: half,
      y: half,
      radius,
      bearing: map.getBearing(),
      ink,
      paper,
    });
  };

  position();
  paint();
  // `rotate` covers drag-rotation and eased rotation alike; `load` catches a
  // style that arrives with a bearing already set.
  map.on('rotate', paint);
  map.on('load', paint);

  return {
    element: canvas,
    get placement() {
      return placement;
    },
    get visible() {
      return visible;
    },

    /** @param {string} key one of {@link PLACEMENTS}, or a falsy value to hide */
    setPlacement(key) {
      if (!key || key === 'off') {
        visible = false;
      } else {
        placement = key;
        visible = true;
      }
      position();
      paint();
    },

    /** @param {number} value outer ring radius in CSS px */
    setRadius(value) {
      radius = value;
      paint();
    },

    /** @param {boolean} value */
    setVisible(value) {
      visible = !!value;
      position();
      paint();
    },

    setColors(nextInk, nextPaper) {
      ink = nextInk ?? ink;
      paper = nextPaper ?? paper;
      paint();
    },

    /**
     * Paint the rose into another context — the PNG export's canvas — in the
     * corner it occupies on screen, at the size it appears there.
     *
     * @param {CanvasRenderingContext2D} target
     * @param {number} width export width, device px
     * @param {number} height export height, device px
     * @param {number} k device px per on-screen CSS px
     * @returns {boolean} false when the rose is hidden and nothing was drawn
     */
    paintInto(target, width, height, k) {
      if (!visible) return false;
      const spot = PLACEMENTS[placement];
      const margin = (inset + radius * EXTENT) * k;
      drawCompassRose(target, {
        x: spot.x === 'left' ? margin : width - margin,
        y: spot.y === 'top' ? margin : height - margin,
        radius: radius * k,
        bearing: map.getBearing(),
        ink,
        paper,
      });
      return true;
    },

    remove() {
      map.off('rotate', paint);
      map.off('load', paint);
      canvas.remove();
    },
  };
}

// --------------------------------------------------------------------------
// parts
// --------------------------------------------------------------------------

/** A soft parchment disc, so the rose stays legible over any basemap. */
function drawBacking(ctx, R, paper) {
  const outer = R * 1.3;
  const gradient = ctx.createRadialGradient(0, 0, R * 0.1, 0, 0, outer);
  gradient.addColorStop(0, withAlpha(paper, 0.92));
  gradient.addColorStop(0.72, withAlpha(paper, 0.78));
  gradient.addColorStop(1, withAlpha(paper, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, outer, 0, TAU);
  ctx.fill();
}

/** The graduated limb: two rings with degree ticks between them. */
function drawLimb(ctx, R, ink) {
  ctx.strokeStyle = ink;

  ctx.lineWidth = Math.max(0.7, R * 0.016);
  ring(ctx, R);
  ctx.lineWidth = Math.max(0.5, R * 0.010);
  ring(ctx, R * 0.885);
  ring(ctx, R * 0.845);

  // 5-degree graduations, longer every 15 and again every 45.
  for (let i = 0; i < 72; i++) {
    const angle = (i * 5 * Math.PI) / 180 - Math.PI / 2;
    const major = i % 9 === 0;
    const mid = i % 3 === 0;
    const inner = R * 0.885;
    const outer = major ? R : mid ? R * 0.965 : R * 0.94;
    ctx.lineWidth = major ? Math.max(0.8, R * 0.018) : Math.max(0.4, R * 0.008);
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    ctx.stroke();
  }
}

/**
 * The 16-point star. Each point is split along its axis, one half inked and
 * one half left as paper - the chiaroscuro that makes an engraved rose read as
 * three-dimensional.
 *
 * Drawn shortest-first so the cardinal points sit on top.
 */
function drawStar(ctx, R, ink, light) {
  // Each point's shoulders lie along its *neighbours'* directions, one step of
  // 22.5 degrees away. That is what gives an engraved rose its broad
  // interlocking kites; putting the shoulders close to the axis instead
  // produces thin spokes that read as a starburst, not a compass.
  const shoulder = TAU / 16;

  // Tier 2 = the eight secondary points, 1 = intercardinal, 0 = cardinal.
  // Drawn in that order so the long points overlap the short ones.
  for (const want of [2, 1, 0]) {
    for (let k = 0; k < 16; k++) {
      const tier = k % 4 === 0 ? 0 : k % 2 === 0 ? 1 : 2;
      if (tier !== want) continue;

      const angle = (k * TAU) / 16 - Math.PI / 2;
      // North is cut short: the fleur-de-lis continues it to the limb.
      const length =
        k === 0 ? R * 0.52 : tier === 0 ? R * 0.8 : tier === 1 ? R * 0.55 : R * 0.34;
      const base = tier === 0 ? R * 0.22 : tier === 1 ? R * 0.16 : R * 0.095;

      const tip = polar(length, angle);
      const left = polar(base, angle - shoulder);
      const right = polar(base, angle + shoulder);

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(left[0], left[1]);
      ctx.lineTo(tip[0], tip[1]);
      ctx.closePath();
      ctx.fillStyle = ink;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(right[0], right[1]);
      ctx.lineTo(tip[0], tip[1]);
      ctx.closePath();
      ctx.fillStyle = light;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(left[0], left[1]);
      ctx.lineTo(tip[0], tip[1]);
      ctx.lineTo(right[0], right[1]);
      ctx.closePath();
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(0.5, R * 0.011);
      ctx.stroke();
    }
  }
}

function drawHub(ctx, R, ink, light) {
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.075, 0, TAU);
  ctx.fillStyle = light;
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(0.6, R * 0.013);
  ctx.stroke();
}

/**
 * The fleur-de-lis over north. Kept deliberately simple: a lance, two lobes
 * and a collar. Anything more detailed turns to mush at this size.
 */
function drawFleur(ctx, R, ink, light) {
  const s = R * 0.26;
  ctx.save();
  // Seat the collar on the shortened north point; the lance then reaches the
  // inner ring of the limb.
  ctx.translate(0, -R * 0.52 - 0.2 * s);
  ctx.scale(s, s);
  ctx.lineWidth = 0.09;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;

  // Lance.
  ctx.beginPath();
  ctx.moveTo(0, -1.05);
  ctx.bezierCurveTo(-0.22, -0.62, -0.2, -0.3, -0.13, -0.05);
  ctx.lineTo(0.13, -0.05);
  ctx.bezierCurveTo(0.2, -0.3, 0.22, -0.62, 0, -1.05);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Side lobes.
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 0.12, -0.42);
    ctx.bezierCurveTo(side * 0.62, -0.66, side * 0.86, -0.24, side * 0.5, 0.0);
    ctx.bezierCurveTo(side * 0.34, 0.08, side * 0.16, -0.08, side * 0.12, -0.42);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Collar.
  ctx.beginPath();
  ctx.moveTo(-0.46, 0.04);
  ctx.lineTo(0.46, 0.04);
  ctx.lineTo(0.34, 0.2);
  ctx.lineTo(-0.34, 0.2);
  ctx.closePath();
  ctx.fillStyle = light;
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

/** Cardinal letters, upright with respect to the rose. */
function drawLetters(ctx, R, ink) {
  const r = R * 1.16;
  const size = Math.max(8, R * 0.27);
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${size}px ui-serif, Georgia, "Times New Roman", serif`;

  const letters = [
    ['N', 0, -r],
    ['E', r, 0],
    ['S', 0, r],
    ['W', -r, 0],
  ];
  for (const [glyph, lx, ly] of letters) {
    // Nudge down a touch: optical centring beats metric centring for capitals.
    ctx.fillText(glyph, lx, ly + size * 0.04);
  }
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function ring(ctx, r) {
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.stroke();
}

function polar(r, angle) {
  return [Math.cos(angle) * r, Math.sin(angle) * r];
}

/** Accepts `#rgb`, `#rrggbb` or any `rgb(...)`/named colour the canvas knows. */
function withAlpha(color, alpha) {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full =
      hex.length === 3
        ? hex.split('').map((c) => c + c).join('')
        : hex.slice(0, 6);
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  // Fall back to compositing the colour at reduced global alpha upstream.
  return color;
}
