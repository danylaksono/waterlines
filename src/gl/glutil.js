/**
 * glutil.js
 *
 * The small amount of WebGL2 boilerplate the distance-field renderer needs.
 * Deliberately not a framework: four programs, three render targets and two
 * buffers do not justify one, and keeping it here means the GL path has no
 * dependencies either.
 */

/**
 * Acquire a WebGL2 context able to render to float textures.
 *
 * The float requirement is the real one: jump flooding stores *coordinates*
 * per pixel, and 16-bit floats lose integer precision above 2048, which is
 * inside the range of an ordinary viewport at devicePixelRatio 2.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {WebGL2RenderingContext|null} null when the platform cannot do it
 */
export function acquireContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    depth: false,
    stencil: true,
    antialias: false, // the shader antialiases from the field; MSAA would be waste
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    desynchronized: true,
  });
  if (!gl) return null;
  if (!gl.getExtension('EXT_color_buffer_float')) return null;
  return gl;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertexSource
 * @param {string} fragmentSource
 * @returns {WebGLProgram}
 */
export function createProgram(gl, vertexSource, fragmentSource) {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  // Pin the position attribute to slot 0 in every program. The seed pass and
  // the stencil pass share one vertex array, and a VAO records which slot each
  // buffer feeds - so if the linker happened to assign them different slots,
  // the second program would read from an unbound attribute.
  gl.bindAttribLocation(program, 0, 'a_pos');
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`waterlines: shader link failed\n${log}`);
  }
  return program;
}

/**
 * Cache of uniform and attribute locations for a program.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @returns {{program: WebGLProgram, u: Record<string, WebGLUniformLocation>, a: Record<string, number>}}
 */
export function describeProgram(gl, program) {
  const u = {};
  const uniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < uniforms; i++) {
    const name = gl.getActiveUniform(program, i).name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(program, name);
  }
  const a = {};
  const attribs = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < attribs; i++) {
    const name = gl.getActiveAttrib(program, i).name;
    a[name] = gl.getAttribLocation(program, name);
  }
  return { program, u, a };
}

/**
 * A colour texture, optionally with a stencil, sized in device pixels.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {Object} [options]
 * @param {number} [options.internalFormat] defaults to `RG32F`
 * @param {number} [options.format] defaults to `RG`
 * @param {number} [options.type] defaults to `FLOAT`
 * @param {boolean} [options.stencil=false]
 * @returns {Object} target with `resize`, `bind`, `texture`, `dispose`
 */
export function createTarget(gl, options = {}) {
  const internalFormat = options.internalFormat ?? gl.RG32F;
  const format = options.format ?? gl.RG;
  const type = options.type ?? gl.FLOAT;

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // NEAREST is not a quality choice: the texels hold seed *coordinates*, and
  // interpolating two of them yields a point that is on neither coastline.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  let stencil = null;
  if (options.stencil) {
    stencil = gl.createRenderbuffer();
    // A name from createRenderbuffer is not yet a renderbuffer *object*: its
    // type is established by the first bind. Attaching before that is an
    // INVALID_OPERATION, and a silent one - the draw simply produces nothing.
    gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      stencil
    );
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  let width = 0;
  let height = 0;

  return {
    texture,
    framebuffer,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    resize(w, h) {
      if (w === width && h === height) return;
      width = w;
      height = h;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
      if (stencil) {
        gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, w, h);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      }
      // An incomplete framebuffer draws nothing and reports nothing. Since the
      // formats here depend on driver support, say so loudly rather than
      // shipping a blank overlay.
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`waterlines: incomplete framebuffer (0x${status.toString(16)})`);
      }
    },
    bind() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, width, height);
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      if (stencil) gl.deleteRenderbuffer(stencil);
    },
  };
}

/**
 * Bake a style's colour and opacity ramps into a 1D lookup texture.
 *
 * A style's colour may be a CSS string, an array of them, or an arbitrary
 * function of position (the `bands` preset's is). Sampling it on the CPU into
 * a texture is what lets every one of those work unchanged in a shader.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture reused across calls
 * @param {(t:number) => string} colorAt t = 0 innermost .. 1 outermost
 * @param {(i:number) => number} alphaAt by waterline index
 * @param {number} n outermost waterline index
 * @param {number} [size=128]
 */
export function uploadRamp(gl, texture, colorAt, alphaAt, n, size = 128) {
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    // Texel i is waterline index `i / (size - 1) * n`, outermost first, which
    // is the order the shader samples in.
    const slot = (i / (size - 1)) * n;
    const [r, g, b] = parseColor(colorAt(1 - slot / (n || 1)));
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(alphaAt(slot) * 255)));
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
}

/**
 * CSS colour -> [r, g, b, a], a in 0..1.
 *
 * Handles the forms the style API actually produces: `#rgb`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()` and `rgba()`. Anything else falls back to opaque black
 * rather than throwing, since a style is user input.
 *
 * @param {string} css
 * @returns {[number, number, number, number]}
 */
export function parseColor(css) {
  if (typeof css !== 'string') return [0, 0, 0, 1];
  const s = css.trim();

  if (s[0] === '#') {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const v = hex.split('').map((c) => parseInt(c + c, 16));
      return [v[0], v[1], v[2], hex.length === 4 ? v[3] / 255 : 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      const v = [];
      for (let i = 0; i < hex.length; i += 2) v.push(parseInt(hex.slice(i, i + 2), 16));
      return [v[0], v[1], v[2], hex.length === 8 ? v[3] / 255 : 1];
    }
    return [0, 0, 0, 1];
  }

  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const channel = (v) =>
      v.endsWith('%')
        ? Math.round((parseFloat(v) / 100) * 255)
        : Math.round(parseFloat(v));
    return [
      channel(parts[0]) || 0,
      channel(parts[1]) || 0,
      channel(parts[2]) || 0,
      parts.length > 3 ? parseFloat(parts[3]) : 1,
    ];
  }
  return [0, 0, 0, 1];
}

/**
 * Passes of jump flooding needed to reach `radius` pixels.
 *
 * Textbook JFA starts at half the image and is exact everywhere. Here only
 * distances up to the ripple extent are ever read, so the flood starts at the
 * smallest power of two covering that radius instead - which at a typical
 * extent turns eleven passes over the viewport into seven. Pixels further out
 * than `radius` end up with no seed, and the shader discards them.
 *
 * @param {number} radius device px
 * @param {number} [max=14] hard ceiling
 * @returns {number[]} step sizes, largest first, ending at 1
 */
export function floodSteps(radius, max = 14) {
  const r = Math.max(1, radius);
  let step = 2 ** Math.ceil(Math.log2(r));
  const steps = [];
  while (step >= 1 && steps.length < max) {
    steps.push(step);
    step /= 2;
  }
  // JFA+1: one extra unit-step pass. Cheap, and it removes most of the rare
  // errors the halving schedule leaves behind.
  steps.push(1);
  return steps;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`waterlines: ${kind} shader failed to compile\n${log}`);
  }
  return shader;
}
