/**
 * GLSL fragments shared by every pass.
 *
 * The colour matrices are interpolated from the same constants the TypeScript
 * side uses, so a shader and a unit test can never disagree about what
 * Display-P3 is.
 */

import { BAND_HUES, BAND_WIDTHS } from '../../color/bands';
import { mat3ToGlsl } from '../../color/matrix';
import { SKIN_HUE_CENTER, SKIN_HUE_WIDTH } from '../../color/oklab';
import {
  DISPLAY_P3_TO_LMS,
  DISPLAY_P3_TO_SRGB,
  DISPLAY_P3_TO_XYZ,
  LMS_TO_DISPLAY_P3,
  LMS_TO_OKLAB,
  OKLAB_TO_LMS,
  SRGB_TO_DISPLAY_P3,
} from '../../color/spaces';

export const GLSL_HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
`;

export const GLSL_COLOR = `
const mat3 SRGB_TO_P3   = ${mat3ToGlsl(SRGB_TO_DISPLAY_P3)};
const mat3 P3_TO_SRGB   = ${mat3ToGlsl(DISPLAY_P3_TO_SRGB)};
const mat3 P3_TO_LMS    = ${mat3ToGlsl(DISPLAY_P3_TO_LMS)};
const mat3 LMS_TO_P3    = ${mat3ToGlsl(LMS_TO_DISPLAY_P3)};
const mat3 LMS_TO_OKLAB = ${mat3ToGlsl(LMS_TO_OKLAB)};
const mat3 OKLAB_TO_LMS = ${mat3ToGlsl(OKLAB_TO_LMS)};

const vec3 P3_LUMA = vec3(
  ${DISPLAY_P3_TO_XYZ[3].toPrecision(10)},
  ${DISPLAY_P3_TO_XYZ[4].toPrecision(10)},
  ${DISPLAY_P3_TO_XYZ[5].toPrecision(10)}
);

const float SKIN_HUE_CENTER = ${SKIN_HUE_CENTER.toFixed(6)};
const float SKIN_HUE_WIDTH  = ${SKIN_HUE_WIDTH.toFixed(6)};

float luma(vec3 c) { return dot(c, P3_LUMA); }

// Display-P3 shares the sRGB transfer curve and differs only in primaries.
float encodeChannel(float l) {
  float a = abs(l);
  float v = a <= 0.0031308 ? a * 12.92 : 1.055 * pow(a, 1.0 / 2.4) - 0.055;
  return l < 0.0 ? -v : v;
}
float decodeChannel(float c) {
  float a = abs(c);
  float v = a <= 0.04045 ? a / 12.92 : pow((a + 0.055) / 1.055, 2.4);
  return c < 0.0 ? -v : v;
}
vec3 encodeTransfer(vec3 l) {
  return vec3(encodeChannel(l.r), encodeChannel(l.g), encodeChannel(l.b));
}
vec3 decodeTransfer(vec3 c) {
  return vec3(decodeChannel(c.r), decodeChannel(c.g), decodeChannel(c.b));
}

// Sign-preserving cube root: wide-gamut colours leave the cone response
// negative, and clamping there would fold them onto the gamut boundary before
// anything has had a chance to look at them.
vec3 cbrtSigned(vec3 v) {
  return sign(v) * pow(abs(v), vec3(1.0 / 3.0));
}

vec3 linearToOklab(vec3 rgb) {
  return LMS_TO_OKLAB * cbrtSigned(P3_TO_LMS * rgb);
}
vec3 oklabToLinear(vec3 lab) {
  vec3 lms = OKLAB_TO_LMS * lab;
  return LMS_TO_P3 * (lms * lms * lms);
}

// How strongly a hue belongs to the skin band: 1 at its centre, 0 outside it.
float skinHueWeight(float hue) {
  float d = hue - SKIN_HUE_CENTER;
  d = mod(d + 3.14159265, 6.28318531) - 3.14159265;
  float t = clamp(abs(d) / SKIN_HUE_WIDTH, 0.0, 1.0);
  return 1.0 - smoothstep(0.0, 1.0, t);
}

// Interleaved gradient noise: one hash, no texture, and no visible tiling.
float hashNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

/**
 * The hue bands the per-colour sliders act on.
 *
 * Centres and widths come from the TypeScript catalogue, which derives them from
 * the primaries. Bands overlap, and the weights are normalised per pixel, so a
 * hue sitting between two of them is moved by both instead of being moved twice.
 */
export const GLSL_HUE_BANDS = `
const int BAND_COUNT = ${BAND_HUES.length};
const float BAND_HUE[BAND_COUNT] = float[BAND_COUNT](
  ${BAND_HUES.map((h) => h.toFixed(6)).join(', ')}
);
const float BAND_WIDTH[BAND_COUNT] = float[BAND_COUNT](
  ${BAND_WIDTHS.map((w) => w.toFixed(6)).join(', ')}
);

float bandWeight(int i, float hue) {
  float d = hue - BAND_HUE[i];
  d = mod(d + 3.14159265, 6.28318531) - 3.14159265;
  float t = clamp(abs(d) / BAND_WIDTH[i], 0.0, 1.0);
  return 1.0 - smoothstep(0.0, 1.0, t);
}
`;

/**
 * Highlight rolloff applied once, on the way out.
 *
 * Everything upstream is scene-referred and may exceed 1.0. Hard-clipping at the
 * encode step turns a bright cheek into a flat white patch with a hard edge; a
 * shoulder keeps the gradient.
 */
export const GLSL_TONEMAP = `
const float SHOULDER = 0.72;

vec3 toneMap(vec3 c) {
  vec3 over = max(c - SHOULDER, 0.0);
  vec3 rolled = (1.0 - SHOULDER) * tanh(over / max(1.0 - SHOULDER, 1e-4));
  return min(c, SHOULDER) + rolled;
}
`;
