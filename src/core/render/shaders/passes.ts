/**
 * Fragment shaders, one per pipeline stage.
 *
 * Stage order is fixed by the pipeline, not by these strings, but the reasons
 * live with the code they constrain: grain has to come after every smoothing
 * step or it is smoothed away, and the output transform has to be last because
 * everything before it is scene-referred.
 *
 * Text is the exception, and a deliberate one. It is composited after the output
 * transform, because a caption is not light that was in the room: pushing it
 * through the highlight rolloff would make white text come out grey and a flat
 * colour come out shifted, both of which read as a bug rather than as a look.
 */

import { GLSL_COLOR, GLSL_HEADER, GLSL_HUE_BANDS, GLSL_TONEMAP } from './common';

/**
 * Ingest: source pixels to the linear Display-P3 working space, framed.
 *
 * Flips, rotation, straightening and the crop arrive as one matrix taking the
 * output coordinate back to the source, so the framing is one resample. Resampling here rather than later means it happens in linear
 * light, before anything has been graded — resampling display-encoded pixels
 * darkens every edge it touches.
 *
 * The transfer function is already undone by the texture's sRGB internal format,
 * so all that is left is the change of primaries.
 *
 * Reducing, the frame is a Lanczos-2 filter laid on the output grid: 8x8 taps
 * half an output pixel apart, along whatever direction the framing turned an
 * output pixel into, each read from the mip level no coarser than that spacing.
 * A single trilinear fetch blends two box reductions, which on a zone plate
 * reduced 3.3x kept 80% of the amplitude just under Nyquist and let 56% through
 * just over it; the filter is what a reduction for a feed should look like.
 * Within a few per cent of the source size the fetch is left as it was, so a
 * frame at its own size comes out pixel for pixel.
 */
export const INGEST_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
uniform sampler2D uSource;
uniform mat3 uGeometry;
uniform int uFromSrgb;

float lanczos2(float x) {
  x = abs(x);
  if (x >= 2.0) return 0.0;
  if (x < 1e-4) return 1.0;
  float p = 3.14159265 * x;
  return 2.0 * sin(p) * sin(p * 0.5) / (p * p);
}

void main() {
  vec2 uv = (uGeometry * vec3(vUv, 1.0)).xy;
  // One output pixel, in source coordinates. The framing is affine, so these
  // are exact and the same everywhere.
  vec2 stepX = dFdx(uv);
  vec2 stepY = dFdy(uv);
  vec2 size = vec2(textureSize(uSource, 0));
  float ratio = max(length(stepX * size), length(stepY * size));

  vec3 c;
  if (ratio < 1.05) {
    c = texture(uSource, uv).rgb;
  } else {
    float lod = max(0.0, floor(log2(ratio * 0.5)));
    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i < 8; i++) {
      float u = (float(i) - 3.5) * 0.5;
      float wu = lanczos2(u);
      for (int j = 0; j < 8; j++) {
        float v = (float(j) - 3.5) * 0.5;
        float w = wu * lanczos2(v);
        sum += w * textureLod(uSource, uv + u * stepX + v * stepY, lod).rgb;
        total += w;
      }
    }
    // The negative lobes can take a pixel beside a highlight below zero, and
    // there is no light below zero.
    c = max(sum / total, 0.0);
  }
  if (uFromSrgb == 1) c = SRGB_TO_P3 * c;
  fragColor = vec4(c, 1.0);
}
`;

/** Separable Gaussian, used for the low-frequency reference glow spreads. */
export const BLUR_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D uSource;
uniform vec2 uStep;

const float W0 = 0.227027;
const float W1 = 0.194595;
const float W2 = 0.121622;
const float W3 = 0.054054;
const float W4 = 0.016216;

void main() {
  vec3 sum = texture(uSource, vUv).rgb * W0;
  sum += (texture(uSource, vUv + uStep * 1.0).rgb + texture(uSource, vUv - uStep * 1.0).rgb) * W1;
  sum += (texture(uSource, vUv + uStep * 2.0).rgb + texture(uSource, vUv - uStep * 2.0).rgb) * W2;
  sum += (texture(uSource, vUv + uStep * 3.0).rgb + texture(uSource, vUv - uStep * 3.0).rgb) * W3;
  sum += (texture(uSource, vUv + uStep * 4.0).rgb + texture(uSource, vUv - uStep * 4.0).rgb) * W4;
  fragColor = vec4(sum, 1.0);
}
`;

/**
 * The guide clarity's base is filtered by: log luminance, twice.
 *
 * Guide and signal are the same thing here, in the two channels the guided
 * filter's deviation and coefficient passes read them from.
 */
export const CLARITY_GUIDE_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
uniform sampler2D uSource;

void main() {
  float l = log2(max(luma(texture(uSource, vUv).rgb), 1e-4));
  fragColor = vec4(l, l, 0.0, 1.0);
}
`;

/**
 * Sharpening's detail: log luminance against the four neighbours a proxy pixel
 * away. Luminance only — sharpening the channels separately pulls them apart at
 * every edge, which is the coloured fringe that gives away an over-processed
 * photo.
 */
export const SHARPEN_DETAIL_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
uniform sampler2D uSource;
uniform vec2 uStep;

void main() {
  vec3 around = (
    texture(uSource, vUv + vec2(uStep.x, 0.0)).rgb +
    texture(uSource, vUv - vec2(uStep.x, 0.0)).rgb +
    texture(uSource, vUv + vec2(0.0, uStep.y)).rgb +
    texture(uSource, vUv - vec2(0.0, uStep.y)).rgb
  ) * 0.25;
  float centre = luma(texture(uSource, vUv).rgb);
  fragColor = vec4(log2(max(centre, 1e-4)) - log2(max(luma(around), 1e-4)), 0.0, 0.0, 1.0);
}
`;

/**
 * Plain resample, for building the reduced-resolution copies.
 *
 * All four channels: the defocus reduces a premultiplied frame whose alpha is
 * the background weight, and a copy that wrote one there made the gather divide
 * by the tap count, darkening the background towards every subject edge.
 */
export const COPY_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D uSource;
void main() {
  fragColor = texture(uSource, vUv);
}
`;

/**
 * Grade: exposure, tonal ranges, white balance, colour and the tone curve.
 *
 * All of it runs scene-referred in linear light. Contrast and the range splits
 * work in log2 because equal ratios of light are what look like equal steps;
 * doing the same in linear crushes the shadows and barely touches the
 * highlights.
 *
 * The colour operations run in order of how sweeping they are — overall
 * saturation, then the per-hue bands, then the monochrome conversion, then the
 * tint on the ends of the range. Reversing any pair changes the result: toning
 * before the conversion to monochrome, for one, is toning that gets thrown away.
 */
export const GRADE_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_HUE_BANDS}
uniform sampler2D uSource;
uniform sampler2D uCurve;

uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTemperature;
uniform float uTint;
uniform float uVibrance;
uniform float uSaturation;
uniform float uSkinProtect;
uniform vec3  uHsl[BAND_COUNT];
uniform int   uUseHsl;
uniform float uMonoAmount;
uniform vec3  uMonoWeights;
uniform float uSplitShadowHue;
uniform float uSplitShadowAmount;
uniform float uSplitHighlightHue;
uniform float uSplitHighlightAmount;
uniform float uSplitBalance;
uniform float uFade;
uniform float uVignette;
uniform float uVignetteMid;
uniform float uVignetteFeather;
uniform float uVignetteRound;
uniform float uAspect;
uniform int   uUseCurve;

const float MID_GREY = 0.18;

// Table entry i is the curve at i/(size-1), and a texel's centre is (i+0.5)/size.
// Past white the curve carries on at unit slope from where it ended, so scene
// highlights above it reach the rolloff as distinct values rather than one.
float curveAt(sampler2D lut, float d) {
  float size = float(textureSize(lut, 0).x);
  float u = (clamp(d, 0.0, 1.0) * (size - 1.0) + 0.5) / size;
  return texture(lut, vec2(u, 0.5)).r + max(d - 1.0, 0.0);
}

void main() {
  vec3 c = texture(uSource, vUv).rgb;

  // Exposure, as stops.
  c *= exp2(uExposure * 3.0);

  // White balance. The channel gains are renormalised so that moving the slider
  // changes colour without also changing how bright the photo is.
  vec3 wb = vec3(1.0 + uTemperature * 0.30, 1.0 + uTint * 0.12, 1.0 - uTemperature * 0.30);
  float before = luma(c);
  c *= wb;
  float after = luma(c);
  c *= before / max(after, 1e-5);

  // Contrast about mid grey, in stops.
  vec3 lg = log2(max(c, 1e-5));
  float pivot = log2(MID_GREY);
  lg = pivot + (lg - pivot) * (1.0 + uContrast * 0.6);
  c = exp2(lg);

  // Highlight and shadow recovery, keyed off a display-referred proxy so the
  // masks sit where the eye sees them rather than where the numbers are.
  float t = encodeChannel(clamp(luma(c), 0.0, 4.0));
  float hiMask = smoothstep(0.42, 1.0, t);
  float loMask = 1.0 - smoothstep(0.0, 0.58, t);
  c *= exp2(uHighlights * hiMask * 1.1 + uShadows * loMask * 1.1);

  // End points. Both sliders brighten upwards, so a negative Blacks pulls the
  // black point down into the shadows.
  float black = -uBlacks * 0.06;
  c = (c - black) / max(1.0 - black, 1e-3);
  c /= max(1.0 - uWhites * 0.20, 1e-3);

  // Vignette, as a change of exposure rather than a dark overlay: darkening the
  // corners by mixing towards black flattens whatever colour was there, while
  // taking light away from them leaves the colour and moves the tone.
  if (abs(uVignette) > 1e-4) {
    vec2 shape = vec2(mix(1.0, uAspect, uVignetteRound), 1.0);
    vec2 p = (vUv - 0.5) * 2.0 * shape;
    float r = length(p) / max(length(shape), 1e-4);
    float m = smoothstep(uVignetteMid, uVignetteMid + max(uVignetteFeather, 0.02), r);
    c *= exp2(-uVignette * m * 2.0);
  }

  // Saturation as Oklch chroma. Vibrance weights the gain towards colours that
  // are not already saturated, and skin protection pulls it back inside the
  // hue band where faces live, which is what stops a colour lift from turning
  // people red.
  if (abs(uVibrance) > 1e-4 || abs(uSaturation) > 1e-4) {
    vec3 lab = linearToOklab(c);
    float chroma = length(lab.yz);
    float hue = atan(lab.z, lab.y);
    float vib = uVibrance * (1.0 - smoothstep(0.0, 0.20, chroma));
    float gain = 1.0 + uSaturation * 0.8 + vib * 0.9;
    float protect = uSkinProtect * skinHueWeight(hue);
    gain = mix(gain, 1.0 + (gain - 1.0) * 0.25, protect);
    chroma = max(0.0, chroma * gain);
    float len = max(length(lab.yz), 1e-6);
    lab.yz = lab.yz / len * chroma;
    c = oklabToLinear(lab);
  }

  // Per-hue adjustments. The weights are gated on chroma: a near-neutral pixel
  // has a hue in the arithmetic sense only, and letting the bands act on it
  // turns the noise in a grey sky into patches of colour.
  if (uUseHsl == 1) {
    vec3 lab = linearToOklab(c);
    float chroma = length(lab.yz);
    float gate = smoothstep(0.012, 0.05, chroma);
    if (gate > 0.0) {
      float hue = atan(lab.z, lab.y);
      float total = 0.0;
      float rotate = 0.0;
      float sat = 0.0;
      float lum = 0.0;
      for (int i = 0; i < BAND_COUNT; i++) {
        float w = bandWeight(i, hue);
        if (w <= 0.0) continue;
        total += w;
        rotate += w * uHsl[i].x * BAND_WIDTH[i] * 0.5;
        sat += w * uHsl[i].y;
        lum += w * uHsl[i].z;
      }
      if (total > 1e-4) {
        float inv = gate / total;
        hue += rotate * inv;
        chroma = max(0.0, chroma * (1.0 + sat * inv * 0.8));
        lab.x = max(0.0, lab.x * (1.0 + lum * inv * 0.35));
        lab.yz = vec2(cos(hue), sin(hue)) * chroma;
        c = oklabToLinear(lab);
      }
    }
  }

  // Monochrome, mixed in linear light so the channel weights mean what they say.
  if (uMonoAmount > 1e-4) {
    float y = max(dot(c, uMonoWeights), 0.0);
    c = mix(c, vec3(y), uMonoAmount);
  }

  // Split toning: chroma added at a fixed hue, weighted towards each end of the
  // range. Adding it in Oklab keeps the lightness where it was, so a tint does
  // not quietly become an exposure change.
  if (uSplitShadowAmount > 1e-4 || uSplitHighlightAmount > 1e-4) {
    float y = clamp(encodeChannel(clamp(luma(c), 0.0, 1.0)), 0.0, 1.0);
    float divide = clamp(0.5 + uSplitBalance * 0.35, 0.05, 0.95);
    float loW = 1.0 - smoothstep(0.0, divide, y);
    float hiW = smoothstep(divide, 1.0, y);
    vec3 lab = linearToOklab(c);
    float hs = radians(uSplitShadowHue);
    float hh = radians(uSplitHighlightHue);
    lab.yz += loW * uSplitShadowAmount * 0.12 * vec2(cos(hs), sin(hs));
    lab.yz += hiW * uSplitHighlightAmount * 0.12 * vec2(cos(hh), sin(hh));
    c = oklabToLinear(lab);
  }

  // Matte finish: the black point lifted display-referred, which is where the
  // effect is defined — a print that was never quite black.
  if (uFade > 1e-4) {
    float lift = uFade * 0.22;
    vec3 d = encodeTransfer(max(c, 0.0));
    c = decodeTransfer(lift + d * (1.0 - lift));
  }

  // Tone curve, evaluated display-referred because that is the domain its
  // control points are drawn in. It runs last so it always has the final say.
  if (uUseCurve == 1) {
    vec3 d = encodeTransfer(max(c, 0.0));
    d = vec3(curveAt(uCurve, d.r), curveAt(uCurve, d.g), curveAt(uCurve, d.b));
    c = decodeTransfer(d);
  }

  fragColor = vec4(c, 1.0);
}
`;

/**
 * Finish: sharpening, clarity, glow, grain, rolloff, output transform, text.
 *
 * Clarity is local contrast in log luminance against a base computed on a
 * heavily reduced copy, so its radius is a fraction of the image rather than a
 * pixel count and survives the move from proxy to full resolution unchanged.
 * The base is a guided filter's (He et al. 2013), its coefficients upsampled and
 * applied against this pixel's own luminance (He & Sun 2015): an unsharp mask
 * against a blur rings at every strong edge: on a 3.6-stop step at full
 * clarity a Gaussian base laid a 1.2-stop dark band, this one 0.35 of a stop,
 * and a third of the halo summed over its width. Sharpening is the opposite
 * by design: it works on adjacent pixels, so its radius is scaled with the
 * render size to keep the preview honest about what the export will look like,
 * and read off a copy the proxy's size: four taps a proxy pixel apart on a
 * larger frame are a comb, and on a 4096-pixel export they doubled detail the
 * preview could not show.
 */
export const FINISH_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_TONEMAP}
uniform sampler2D uSource;
uniform sampler2D uLow;
uniform sampler2D uDetail;
uniform sampler2D uSharpenDetail;
uniform sampler2D uText;

uniform float uSharpen;
uniform float uClarity;
uniform float uGlow;
uniform float uGlowThreshold;
uniform float uGrain;
uniform float uGrainSize;
uniform vec2  uResolution;
uniform int   uToSrgb;
uniform int   uFlipY;
uniform int   uDither;
uniform int   uHasText;

// Catmull-Rom over sixteen texels: interpolating, so a frame read at its own
// texel centres comes back exactly, and it keeps the top octave a bilinear
// reconstruction halves.
float catmullRom(sampler2D t, vec2 uv) {
  ivec2 size = textureSize(t, 0);
  vec2 p = uv * vec2(size) - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  float wx[4] = float[4](w0.x, w1.x, w2.x, w3.x);
  float wy[4] = float[4](w0.y, w1.y, w2.y, w3.y);
  float sum = 0.0;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      ivec2 at = clamp(ivec2(i) + ivec2(x - 1, y - 1), ivec2(0), size - 1);
      sum += wx[x] * wy[y] * texelFetch(t, at, 0).r;
    }
  }
  return sum;
}

void main() {
  vec2 uv = uFlipY == 1 ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
  vec3 c = texture(uSource, uv).rgb;

  // Sharpening, measured on the proxy-sized copy and brought up to this size.
  if (uSharpen > 1e-4) {
    float detail = catmullRom(uSharpenDetail, uv);
    c *= exp2(clamp(detail, -1.0, 1.0) * uSharpen * 1.2);
  }

  if (abs(uClarity) > 1e-4) {
    float high = log2(max(luma(c), 1e-4));
    vec2 ab = texture(uDetail, uv).rg;
    float detail = clamp(high - (ab.x * high + ab.y), -1.5, 1.5);
    c *= exp2(detail * uClarity * 0.8);
  }

  // Glow reads the low-frequency copy: the bright parts of a blurred image are
  // exactly the bloom a diffusion filter spreads.
  if (uGlow > 1e-4) {
    vec3 bloom = max(texture(uLow, uv).rgb - decodeChannel(uGlowThreshold), 0.0);
    c += bloom * uGlow * 1.3;
  }

  // Grain goes on last of the picture operations: added earlier, the smoothing
  // stages downstream would take it straight back out. It is monochrome and
  // weighted towards the midtones, where real film grain is most visible. The
  // lattice is half the grain size because a cubic B-spline's spread is twice a
  // box's: a grain is as wide as the square cell it replaced, without the square.
  if (uGrain > 1e-4) {
    float n = latticeNoise(gl_FragCoord.xy, max(uGrainSize, 0.25) * 0.5);
    float y = clamp(luma(c), 0.0, 1.0);
    float weight = 4.0 * y * (1.0 - y);
    c += n * uGrain * 0.12 * weight;
  }

  c = toneMap(max(c, 0.0));
  if (uToSrgb == 1) c = P3_TO_SRGB * c;

  // Text, composited in display-referred linear light and in the output's own
  // primaries. The layer is rasterised at exactly this resolution and sampled
  // without filtering, so the antialiasing the rasteriser produced is the
  // antialiasing that lands in the file.
  if (uHasText == 1) {
    vec4 tx = texture(uText, uv);
    vec3 tl = uToSrgb == 1 ? tx.rgb : SRGB_TO_P3 * tx.rgb;
    c = mix(c, tl, tx.a);
  }

  vec3 encoded = encodeTransfer(clamp(c, 0.0, 1.0));

  // Triangular-PDF dither, a code value either way. Sixteen bits of processing
  // end up in eight, and without this the gradients that survived the pipeline
  // band at the very last step. The two draws are the hash's two independent
  // halves: two interleaved-gradient draws at offset positions correlate at
  // 0.68, and the error's variance then swung from 0.25 to 0.44 of a code with
  // the level's fraction — noise that comes and goes in stripes down a gradient.
  if (uDither == 1) {
    vec2 n = vec2(pcg2d(uvec2(gl_FragCoord.xy))) / 4294967295.0;
    encoded += (n.x + n.y - 1.0) / 255.0;
  }

  fragColor = vec4(clamp(encoded, 0.0, 1.0), 1.0);
}
`;
