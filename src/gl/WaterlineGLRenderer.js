/**
 * WaterlineGLRenderer.js
 *
 * The distance-field renderer: same picture as `render/WaterlineRenderer.js`,
 * arrived at from the other direction.
 *
 * The 2D renderer *constructs* each waterline by stroking a wide pen and
 * erasing its middle, N times. That is N rasterisations of the whole coastline
 * per frame, and it is why the 2D path needs a raster cache, a step scheduler
 * and a draft ladder to stay interactive.
 *
 * This renderer computes the distance to the shore once per frame and *reads
 * off* every waterline from it in a single pass. The consequences are not
 * incremental:
 *
 *  - the number of waterlines is free - 8 lines and 80 cost the same;
 *  - there is nothing to cache, so pan and zoom are exact rather than a
 *    rescaled bitmap, and there is no stale-image window at all;
 *  - the animation phase is a uniform, so it animates *while the map moves*,
 *    which the precomputed-frame approach structurally cannot do.
 *
 * It is map-agnostic in the same way the 2D renderer is: hand it a mesh, an
 * affine and a style, and it draws.
 */

import { colorAccessor, normalisePhase, resolveStyle } from '../render/style.js';
import { powScale } from '../render/scales.js';
import {
  acquireContext,
  createProgram,
  createTarget,
  describeProgram,
  floodSteps,
  parseColor,
  uploadRamp,
} from './glutil.js';
import {
  FLOOD_FRAG,
  MASK_FRAG,
  QUAD_VERT,
  SEED_FRAG,
  SEED_VERT,
  SHADE_FRAG,
} from './shaders.js';

/** Thrown when the platform cannot run the GL path; callers fall back to 2D. */
export class GLUnavailableError extends Error {}

export class WaterlineGLRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Partial<import('../render/style.js').WaterlineStyle> & {preset?:string}} [style]
   */
  constructor(canvas, style) {
    const gl = acquireContext(canvas);
    if (!gl) {
      throw new GLUnavailableError(
        'waterlines: WebGL2 with float render targets is unavailable'
      );
    }
    this.canvas = canvas;
    this.gl = gl;
    this.style = resolveStyle(style);
    this._colorAt = colorAccessor(this.style.color);
    this._rampDirty = true;
    this.lastDrawMs = 0;
    /** Flood passes the last frame ran; the honest cost signal for this path. */
    this.lastPasses = 0;

    this._programs = {
      seed: describeProgram(gl, createProgram(gl, SEED_VERT, SEED_FRAG)),
      flood: describeProgram(gl, createProgram(gl, QUAD_VERT, FLOOD_FRAG)),
      // The stencil pass draws geometry; resolving the parity into coverage
      // draws a fullscreen quad. Same fragment shader, different vertex stage.
      maskFans: describeProgram(gl, createProgram(gl, SEED_VERT, MASK_FRAG)),
      maskResolve: describeProgram(gl, createProgram(gl, QUAD_VERT, MASK_FRAG)),
      shade: describeProgram(gl, createProgram(gl, QUAD_VERT, SHADE_FRAG)),
    };

    // Ping-pong pair for the flood, plus the land mask.
    this._field = [createTarget(gl), createTarget(gl)];
    this._mask = createTarget(gl, {
      internalFormat: gl.R8,
      format: gl.RED,
      type: gl.UNSIGNED_BYTE,
      stencil: true,
    });
    this._ramp = gl.createTexture();

    this._mesh = null;
    this._meshKey = null;
    this._buffers = null;
  }

  /**
   * @param {Partial<import('../render/style.js').WaterlineStyle> & {preset?:string}} style
   */
  setStyle(style) {
    this.style = resolveStyle({ ...this.style, ...style });
    this._colorAt = colorAccessor(this.style.color);
    this._rampDirty = true;
  }

  /**
   * Set only the animation phase.
   *
   * Separate from {@link setStyle} because it is called every frame while
   * animating, and going through `resolveStyle` would rebuild the colour ramp
   * texture sixty times a second for a value the ramp does not depend on.
   *
   * @param {number|null} phase
   */
  setPhase(phase) {
    this.style.phase = normalisePhase(phase);
  }

  /**
   * Upload a level's geometry. Cheap to call per frame - it returns early
   * unless `key` changed, which happens only when the LOD level does.
   *
   * @param {import('./geometry.js').LevelMesh} mesh
   * @param {*} key identity of the mesh, e.g. the LOD zoom
   */
  setMesh(mesh, key) {
    if (key !== undefined && key === this._meshKey && this._mesh === mesh) return;
    const gl = this.gl;

    if (!this._buffers) {
      this._buffers = {
        positions: gl.createBuffer(),
        edges: gl.createBuffer(),
        fans: gl.createBuffer(),
        edgeVao: gl.createVertexArray(),
        fanVao: gl.createVertexArray(),
      };
    }
    const b = this._buffers;
    const loc = this._programs.seed.a.a_pos;

    gl.bindBuffer(gl.ARRAY_BUFFER, b.positions);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);

    gl.bindVertexArray(b.edgeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.positions);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.edges);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.edges, gl.STATIC_DRAW);

    gl.bindVertexArray(b.fanVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.positions);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.fans);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.fans, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    this._mesh = mesh;
    this._meshKey = key;
  }

  /**
   * Draw one frame, whole. There is no step-wise variant and no need for one:
   * the cost does not scale with the waterline count, so there is no job long
   * enough to be worth splitting across frames.
   *
   * @param {Object} frame
   * @param {import('../render/WaterlineRenderer.js').Affine} frame.matrix
   *   normalised mercator -> CSS px
   * @param {number} frame.refWorldSize px per mercator unit the mesh was built at
   * @param {number} frame.width  CSS px
   * @param {number} frame.height CSS px
   * @param {number} [frame.pixelRatio=1]
   * @returns {{ms:number, passes:number}}
   */
  draw(frame) {
    const t0 = now();
    const gl = this.gl;
    const { matrix, refWorldSize, width, height, pixelRatio = 1 } = frame;
    const w = Math.max(1, Math.round(width * pixelRatio));
    const h = Math.max(1, Math.round(height * pixelRatio));

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    for (const target of this._field) target.resize(w, h);
    this._mask.resize(w, h);

    const uMatrix = matrixToMat3(matrix, refWorldSize);
    const size = [w, h];

    if (!this._mesh || !this._mesh.vertices) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.lastDrawMs = now() - t0;
      this.lastPasses = 0;
      return { ms: this.lastDrawMs, passes: 0 };
    }

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    const source = this._seed(uMatrix, size, pixelRatio);
    const field = this._flood(source, size, pixelRatio);
    this._buildMask(uMatrix, size, pixelRatio);
    this._shade(field, size, pixelRatio, w, h);

    this.lastDrawMs = now() - t0;
    return { ms: this.lastDrawMs, passes: this.lastPasses };
  }

  /** Release every GPU resource. */
  destroy() {
    const gl = this.gl;
    for (const p of Object.values(this._programs)) gl.deleteProgram(p.program);
    for (const t of this._field) t.dispose();
    this._mask.dispose();
    gl.deleteTexture(this._ramp);
    if (this._buffers) {
      gl.deleteBuffer(this._buffers.positions);
      gl.deleteBuffer(this._buffers.edges);
      gl.deleteBuffer(this._buffers.fans);
      gl.deleteVertexArray(this._buffers.edgeVao);
      gl.deleteVertexArray(this._buffers.fanVao);
    }
    this._buffers = null;
    this._mesh = null;
  }

  // ------------------------------------------------------------------------
  // passes
  // ------------------------------------------------------------------------

  /** Rasterise the coastline into the field, every covered pixel a seed. */
  _seed(uMatrix, size, ratio) {
    const gl = this.gl;
    const target = this._field[0];
    const { program, u } = this._programs.seed;

    target.bind();
    // -1 is "no seed". A float target has to be cleared through clearBufferfv;
    // clearColor clamps to [0, 1] and would silently make every pixel a seed
    // at the origin.
    gl.clearBufferfv(gl.COLOR, 0, [-1, -1, 0, 0]);

    gl.useProgram(program);
    gl.uniformMatrix3fv(u.u_matrix, false, uMatrix);
    gl.uniform2fv(u.u_size, size);
    gl.uniform1f(u.u_ratio, ratio);

    gl.bindVertexArray(this._buffers.edgeVao);
    gl.drawElements(gl.LINES, this._mesh.edges.length, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    return 0;
  }

  /** Jump flood until every pixel within the ripple extent knows its shore. */
  _flood(sourceIndex, size, ratio) {
    const gl = this.gl;
    const { program, u } = this._programs.flood;
    // Only distances out to the extent are ever read, so the flood only has to
    // reach that far - see `floodSteps`.
    const reach = (this.style.extent + Math.max(2, this.style.lineWidth[1])) * ratio;
    const steps = floodSteps(reach);

    gl.useProgram(program);
    gl.uniform2fv(u.u_size, size);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.u_field, 0);

    let read = sourceIndex;
    for (const step of steps) {
      const write = 1 - read;
      this._field[write].bind();
      gl.bindTexture(gl.TEXTURE_2D, this._field[read].texture);
      gl.uniform1f(u.u_step, step);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      read = write;
    }
    this.lastPasses = steps.length;
    return read;
  }

  /**
   * Land coverage, by the even-odd rule.
   *
   * Each ring is drawn as a triangle fan from its own first vertex with the
   * stencil op set to INVERT. Every fan triangle flips the parity of the
   * pixels it covers, so what survives is exactly the even-odd interior -
   * holes included, no triangulation, no winding rules. This is the same
   * result as `ctx.fill(path, 'evenodd')` in the 2D renderer, which is what
   * keeps the two land masks identical.
   */
  _buildMask(uMatrix, size, ratio) {
    const gl = this.gl;
    const { program, u } = this._programs.maskFans;

    this._mask.bind();
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferiv(gl.STENCIL, 0, new Int32Array([0]));

    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    gl.colorMask(false, false, false, false);

    gl.useProgram(program);
    gl.uniformMatrix3fv(u.u_matrix, false, uMatrix);
    gl.uniform2fv(u.u_size, size);
    gl.uniform1f(u.u_ratio, ratio);

    gl.bindVertexArray(this._buffers.fanVao);
    gl.drawElements(gl.TRIANGLES, this._mesh.fans.length, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    // Resolve parity into coverage.
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.useProgram(this._programs.maskResolve.program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.disable(gl.STENCIL_TEST);
  }

  /** One pass, every waterline. */
  _shade(fieldIndex, size, ratio, w, h) {
    const gl = this.gl;
    const style = this.style;
    const { program, u } = this._programs.shade;
    const n = Math.max(1, Math.round(style.count));

    if (this._rampDirty) {
      const alphaAt = powScale([0, n], style.opacity, style.opacityExponent);
      uploadRamp(gl, this._ramp, this._colorAt, alphaAt, n);
      this._rampDirty = false;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    // The shader emits premultiplied alpha, matching the context's
    // premultipliedAlpha: true, so no unmultiply happens on composite.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._field[fieldIndex].texture);
    gl.uniform1i(u.u_field, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._mask.texture);
    gl.uniform1i(u.u_mask, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._ramp);
    gl.uniform1i(u.u_ramp, 2);

    gl.uniform2fv(u.u_size, size);
    gl.uniform1f(u.u_ratio, ratio);
    gl.uniform1f(u.u_n, n);
    gl.uniform1f(u.u_extent, style.extent);
    gl.uniform1f(u.u_inset, style.inset);
    gl.uniform1f(u.u_spacing, style.spacingExponent);
    gl.uniform2f(u.u_lineWidth, style.lineWidth[0], style.lineWidth[1]);
    gl.uniform1f(u.u_filled, style.filled ? 1 : 0);
    gl.uniform1f(u.u_land, style.land === 'clip' ? 0 : style.land === 'fill' ? 1 : 2);

    const land = parseColor(style.landColor);
    gl.uniform4f(u.u_landColor, land[0] / 255, land[1] / 255, land[2] / 255, land[3]);

    const coast = style.coastline;
    const coastColor = parseColor(coast ? coast.color : '#000');
    gl.uniform3f(
      u.u_coastColor,
      coastColor[0] / 255,
      coastColor[1] / 255,
      coastColor[2] / 255
    );
    gl.uniform1f(u.u_coastWidth, coast ? (coast.width ?? 0.8) : 0);
    gl.uniform1f(u.u_coastAlpha, coast ? (coast.opacity ?? 1) : 0);

    const phase = style.phase;
    gl.uniform1f(u.u_phase, phase == null ? 0 : phase);
    gl.uniform1f(u.u_animated, phase == null ? 0 : 1);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  }
}

/**
 * Affine + reference scale -> the column-major mat3 the vertex shaders take.
 *
 * Mesh coordinates are in the LOD level's reference pixels, so the mercator
 * scale is folded in here rather than baked into the vertices - which is what
 * lets one uploaded mesh serve every pan and zoom within its level.
 *
 * @param {import('../render/WaterlineRenderer.js').Affine} m
 * @param {number} refWorldSize
 * @returns {Float32Array}
 */
export function matrixToMat3(m, refWorldSize) {
  const s = 1 / refWorldSize;
  return new Float32Array([m.a * s, m.b * s, 0, m.c * s, m.d * s, 0, m.e, m.f, 1]);
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
