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
 * output coordinate back to the source, so the sampler does the whole framing in
 * a single fetch. Resampling here rather than later means it happens in linear
 * light, before anything has been graded — resampling display-encoded pixels
 * darkens every edge it touches.
 *
 * The transfer function is already undone by the texture's sRGB internal format,
 * so all that is left is the change of primaries.
 */
export const INGEST_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
uniform sampler2D uSource;
uniform mat3 uGeometry;
uniform int uFromSrgb;

void main() {
  vec2 uv = (uGeometry * vec3(vUv, 1.0)).xy;
  vec3 c = texture(uSource, uv).rgb;
  if (uFromSrgb == 1) c = SRGB_TO_P3 * c;
  fragColor = vec4(c, 1.0);
}
`;

/** Separable Gaussian, used for the low-frequency reference clarity works against. */
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

/** Plain resample, for building the reduced-resolution copies. */
export const COPY_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D uSource;
void main() {
  fragColor = vec4(texture(uSource, vUv).rgb, 1.0);
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

  // End points.
  float black = uBlacks * 0.06;
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
    vec3 d = clamp(encodeTransfer(max(c, 0.0)), 0.0, 1.0);
    d = vec3(
      texture(uCurve, vec2(d.r, 0.5)).r,
      texture(uCurve, vec2(d.g, 0.5)).r,
      texture(uCurve, vec2(d.b, 0.5)).r
    );
    c = decodeTransfer(d);
  }

  fragColor = vec4(c, 1.0);
}
`;

/**
 * Finish: sharpening, clarity, glow, grain, rolloff, output transform, text.
 *
 * Clarity is an unsharp mask in log luminance against a heavily reduced copy, so
 * its radius is a fraction of the image rather than a pixel count and survives
 * the move from proxy to full resolution unchanged. Sharpening is the opposite
 * by design: it works on adjacent pixels, so its radius is scaled with the
 * render size to keep the preview honest about what the export will look like.
 */
export const FINISH_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_TONEMAP}
uniform sampler2D uSource;
uniform sampler2D uLow;
uniform sampler2D uText;

uniform float uSharpen;
uniform vec2  uSharpenStep;
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

void main() {
  vec2 uv = uFlipY == 1 ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
  vec3 c = texture(uSource, uv).rgb;

  // Sharpening acts on luminance only. Sharpening the channels separately pulls
  // them apart at every edge, which is the coloured fringe that gives away an
  // over-processed photo.
  if (uSharpen > 1e-4) {
    vec3 around = (
      texture(uSource, uv + vec2(uSharpenStep.x, 0.0)).rgb +
      texture(uSource, uv - vec2(uSharpenStep.x, 0.0)).rgb +
      texture(uSource, uv + vec2(0.0, uSharpenStep.y)).rgb +
      texture(uSource, uv - vec2(0.0, uSharpenStep.y)).rgb
    ) * 0.25;
    float detail = log2(max(luma(c), 1e-4)) - log2(max(luma(around), 1e-4));
    c *= exp2(clamp(detail, -1.0, 1.0) * uSharpen * 1.2);
  }

  if (abs(uClarity) > 1e-4) {
    float high = log2(max(luma(c), 1e-4));
    float low = log2(max(luma(texture(uLow, uv).rgb), 1e-4));
    float detail = clamp(high - low, -1.5, 1.5);
    c *= exp2(detail * uClarity * 0.8);
  }

  // Glow reuses the low-frequency copy clarity works against: the bright parts
  // of a blurred image are exactly the bloom a diffusion filter spreads.
  if (uGlow > 1e-4) {
    vec3 bloom = max(texture(uLow, uv).rgb - decodeChannel(uGlowThreshold), 0.0);
    c += bloom * uGlow * 1.3;
  }

  // Grain goes on last of the picture operations: added earlier, the smoothing
  // stages downstream would take it straight back out. It is monochrome and
  // weighted towards the midtones, where real film grain is most visible.
  if (uGrain > 1e-4) {
    vec2 cell = gl_FragCoord.xy / max(uGrainSize, 0.25);
    float n = hashNoise(floor(cell)) - 0.5;
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

  // Triangular-PDF dither at half a code value. Sixteen bits of processing end
  // up in eight, and without this the gradients that survived the pipeline band
  // at the very last step.
  if (uDither == 1) {
    float n1 = hashNoise(gl_FragCoord.xy);
    float n2 = hashNoise(gl_FragCoord.xy + vec2(17.0, 31.0));
    encoded += (n1 + n2 - 1.0) / 255.0;
  }

  fragColor = vec4(clamp(encoded, 0.0, 1.0), 1.0);
}
`;
