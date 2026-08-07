/**
 * shaders.js
 *
 * GLSL ES 3.00 for the distance-field waterlines.
 *
 * The whole method in one sentence: stroking a pen of width `w` and erasing a
 * pen of width `w - t` keeps precisely those pixels whose distance to the
 * coastline lies in `[(w - t)/2, w/2]`. So the N-pass stroke-and-erase loop is
 * N slices of a single function - the distance to the shore - and once that
 * function is available per pixel, every waterline is drawn in one pass at a
 * cost that does not depend on N at all.
 *
 * Four programs:
 *
 *  1. `SEED`  - rasterise the coastline, each covered pixel storing its own
 *               coordinates. The initial state of the flood.
 *  2. `FLOOD` - jump flooding (Rong & Tan 2006): log2(R) ping-pong passes,
 *               each propagating the nearest known seed over a halving step.
 *               Leaves every pixel holding its nearest coastline pixel.
 *  3. `MASK`  - resolve the even-odd stencil into a land coverage texture.
 *  4. `SHADE` - the picture. Invert the spacing scale to turn a distance into
 *               a fractional waterline index, round to the nearest line, and
 *               shade the band around it.
 */

const CLIP = /* glsl */ `
// Reference pixels -> clip space. The affine is the same one the 2D renderer
// folds into setTransform, and the y flip is what makes CSS coordinates (y
// down) agree with GL's (y up). Applied identically in every pass, so
// gl_FragCoord means the same thing throughout.
vec4 clipFromRef(vec2 ref, mat3 m, vec2 sizePx, float ratio) {
  vec2 css = (m * vec3(ref, 1.0)).xy;
  vec2 dev = css * ratio;
  return vec4(dev.x / sizePx.x * 2.0 - 1.0, 1.0 - dev.y / sizePx.y * 2.0, 0.0, 1.0);
}
`;

export const SEED_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 a_pos;
uniform mat3 u_matrix;
uniform vec2 u_size;
uniform float u_ratio;
${CLIP}
void main() {
  gl_Position = clipFromRef(a_pos, u_matrix, u_size, u_ratio);
}
`;

export const SEED_FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec2 fragSeed;
void main() {
  // Its own position, in framebuffer pixels. Every later pass compares against
  // gl_FragCoord in that same space, so no conversion is ever needed.
  fragSeed = gl_FragCoord.xy;
}
`;

/** Fullscreen triangle from gl_VertexID; no attributes, no buffer. */
export const QUAD_VERT = /* glsl */ `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FLOOD_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_field;
uniform vec2 u_size;
uniform float u_step;
out vec2 fragSeed;

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 best = texture(u_field, p / u_size).xy;
  float bestD = best.x < 0.0 ? 1e20 : distance(best, p);

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 q = p + vec2(float(dx), float(dy)) * u_step;
      if (q.x < 0.0 || q.y < 0.0 || q.x >= u_size.x || q.y >= u_size.y) continue;
      vec2 s = texture(u_field, q / u_size).xy;
      if (s.x < 0.0) continue;
      float d = distance(s, p);
      if (d < bestD) { bestD = d; best = s; }
    }
  }
  fragSeed = bestD >= 1e20 ? vec2(-1.0) : best;
}
`;

export const MASK_FRAG = /* glsl */ `#version 300 es
precision highp float;
out float fragMask;
void main() { fragMask = 1.0; }
`;

/**
 * The picture.
 *
 * Inverting the spacing scale is the step worth reading twice. The 2D renderer
 * draws waterline `i` at radius `R(i) = extent + (inset - extent) (i/n)^e`.
 * Here a pixel arrives with a radius and needs its line, so the relation runs
 * backwards to a *fractional* line index, rounds to the nearest real line, and
 * recomputes that line's exact radius. The result is exact rather than
 * approximate, and it costs one `pow` instead of a loop over `n`.
 */
export const SHADE_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_field;
uniform sampler2D u_mask;
uniform sampler2D u_ramp;    // 0 = outermost .. 1 = innermost; rgb colour, a opacity
uniform vec2 u_size;
uniform float u_ratio;

uniform float u_n;           // waterline count
uniform float u_extent;      // css px, outermost
uniform float u_inset;       // css px, innermost
uniform float u_spacing;     // spacing exponent
uniform vec2 u_lineWidth;    // [innermost, outermost] css px
uniform float u_filled;      // 1 = solid bands
uniform float u_land;        // 0 = clip, 1 = fill, 2 = leave
uniform vec4 u_landColor;
uniform vec3 u_coastColor;
uniform float u_coastWidth;  // css px; 0 = no coastline
uniform float u_coastAlpha;
uniform float u_phase;       // animation phase, 0..1
uniform float u_animated;    // 1 = animating

out vec4 fragColor;

/** Radius of waterline 'i', css px. The 2D renderer's pen scale, halved. */
float radiusOf(float i) {
  return u_extent + (u_inset - u_extent) * pow(clamp(i / u_n, 0.0, 1.0), u_spacing);
}

/** Visible thickness of waterline 'i' - the 2D renderer's nib scale, halved. */
float thicknessOf(float i) {
  float t = clamp(i / u_n, 0.0, 1.0);
  return mix(u_lineWidth.y, u_lineWidth.x, t * t * t);
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 uv = p / u_size;
  vec2 seed = texture(u_field, uv).xy;
  bool seeded = seed.x >= 0.0;

  // Deep inland is beyond the flooded radius and has no seed. It still needs a
  // signed distance for the land fill, so it gets a large one rather than an
  // early discard.
  float d = seeded ? distance(seed, p) / u_ratio : 1.0e6;
  float inside = texture(u_mask, uv).r;
  float signedD = mix(d, -d, inside);

  // Antialiasing straight off the field: |grad d| is 1 px per px away from the
  // medial axis, so a half-pixel smoothstep is exactly right - no derivatives,
  // and it holds at any resolution.
  float aa = 0.5 / u_ratio;
  vec4 outColor = vec4(0.0);

  if (seeded) {
    // Fractional waterline index for this radius: the spacing scale, inverted.
    float t = clamp((d - u_extent) / (u_inset - u_extent), 0.0, 1.0);
    float idx = pow(t, 1.0 / u_spacing) * u_n;

    // Lines sit at integer indices when still, and at 'j - phase' while
    // animating: over one cycle every line slides outwards into the slot the
    // line ahead of it held. The two ends of that slide cross-fade so the loop
    // closes without a pop - the same seam the 2D renderer applies per pass.
    float shift = u_phase * u_animated;
    float shifted = idx + shift;
    // Lines mode wants the nearest line; bands mode wants the line bounding
    // this pixel on the inside, or a pixel mid-band would be assigned to a
    // band that does not contain it and would fall through as a gap.
    float j = u_filled > 0.5 ? ceil(shifted) : floor(shifted + 0.5);
    float lo = u_animated;
    float hi = u_n + u_animated;

    if (j >= lo && j <= hi) {
      float line = j - shift;
      float slot = clamp(line, 0.0, u_n);
      float r = radiusOf(line);

      float seam = 1.0;
      if (u_animated > 0.5) {
        if (j <= lo) seam = 1.0 - u_phase;
        else if (j >= hi) seam = u_phase;
      }

      float cover;
      if (u_filled > 0.5) {
        float outer = radiusOf(line - 1.0);
        cover = smoothstep(r - aa, r + aa, d) *
                (1.0 - smoothstep(outer - aa, outer + aa, d));
      } else {
        float halfW = max(thicknessOf(slot) * 0.5, 0.35);
        cover = 1.0 - smoothstep(halfW - aa, halfW + aa, abs(d - r));
      }

      vec4 ink = texture(u_ramp, vec2(slot / max(u_n, 1.0), 0.5));
      outColor = vec4(ink.rgb, ink.a * cover * seam);
    }
  }

  // The land. 'clip' leaves it alone so the basemap shows through; 'fill'
  // paints it; 'leave' keeps the inward half of every band, which is what the
  // 2D renderer does when nothing masks the interior.
  if (u_land < 0.5) {
    outColor.a *= smoothstep(-aa, aa, signedD);
  } else if (u_land < 1.5) {
    float land = (1.0 - smoothstep(-aa, aa, signedD)) * u_landColor.a;
    outColor = mix(outColor, vec4(u_landColor.rgb, 1.0), land);
  }

  if (u_coastWidth > 0.0) {
    float halfW = max(u_coastWidth * 0.5, 0.35);
    float coast = 1.0 - smoothstep(halfW - aa, halfW + aa, abs(signedD));
    outColor = mix(outColor, vec4(u_coastColor, 1.0), coast * u_coastAlpha);
  }

  if (outColor.a <= 0.0) discard;
  fragColor = vec4(outColor.rgb * outColor.a, outColor.a);   // premultiplied
}
`;
