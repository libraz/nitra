/**
 * The hair stage: sheen, grey strands, and colour.
 *
 * It runs with the other per-part work, before the grade, for the reason the
 * whole face block runs there: what it adjusts is the surface the light fell on
 * rather than the light.
 *
 * All three amounts are read against a local average of the photograph rather
 * than against a threshold, and that is what makes them mean the same thing on
 * the next photograph. Hair is the darkest large thing in most portraits and the
 * brightest in some; a sheen keyed to an absolute lightness would find the
 * highlight on dark hair and the whole head on light hair.
 *
 * What the stage cannot do is tell a grey strand from a lit one on its own. Both
 * are lighter than the hair around them; what separates them is that the strand
 * has lost its colour while the highlight keeps the hair's. So the grey work
 * asks for both, and it runs before the sheen: a strand put back to the hair's
 * own colour is no longer a candidate for being brightened as a highlight.
 */

import { GLSL_COLOR, GLSL_HEADER } from './common';
import { GLSL_REGION, GLSL_WARP } from './face';

/**
 * How much chroma full tint adds, in Oklab units.
 *
 * Under the lips, which are a smaller region and expected to read as a colour
 * that was applied. Hair that has been dyed is still hair, and the amount that
 * makes it obvious is the amount that makes it a wig.
 */
const TINT_CHROMA = 0.055;

/** How far towards the surrounding hair a fully corrected strand is taken. */
const GREY_REACH = 0.8;

/** How far towards white a full sheen lifts the band it finds. */
const SHEEN_LIFT = 0.35;

/**
 * The hair class, and a guide to snap it to.
 *
 * The same guided filter the skin mask and the background separation are
 * refined by, with the hair confidence for a signal. It needs the refinement
 * more than either of them: the segmentation arrives 256 pixels across, and
 * hair is the finest structure in a portrait, so magnified to a frame its
 * boundary sits somewhere near the hairline rather than on it — and a colour
 * that stops somewhere near the hairline is a smear across a forehead.
 */
export const HAIR_RAW_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
uniform sampler2D uSegment;
uniform sampler2D uImage;

void main() {
  vec2 seg = texture(uSegment, vUv).rg;
  // The face's own skin is taken out of it, which is the mirror of what the skin
  // mask does with the hair. The two classes are branches of one softmax, so
  // where the model is half sure of a forehead it is not to be trusted about a
  // fringe — and on a face small in the frame the whole head is a couple of
  // dozen texels of segmentation, which is where a tint reaches an eye.
  float hair = seg.g * (1.0 - seg.r);
  float guide = linearToOklab(max(texture(uImage, vUv).rgb, 0.0)).x;
  fragColor = vec4(hair, guide, 0.0, 1.0);
}
`;

/**
 * Hair: the grey strands, the sheen, and the colour.
 *
 * The mask is read through the framing and the displacement, like every other
 * mask built in the photograph's own frame. The local average is read at the
 * same place, so the two cannot disagree about which part of the head a pixel
 * belongs to.
 *
 * Colour is added as Oklab chroma at a fixed hue, which leaves the lightness
 * where the photograph had it — the same way split toning and the lip colour
 * work. A tint that also lightens is a wig rather than a dye.
 */
export const HAIR_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_REGION}
${GLSL_WARP}
uniform sampler2D uSource;
uniform sampler2D uHair;
uniform sampler2D uMean;
uniform sampler2D uSkin;
uniform sampler2D uPoly;
uniform mat3 uGeometry;
uniform int uHasFace;

uniform float uSheen;
uniform float uGrey;
uniform float uTint;
uniform float uTintHue;

void main() {
  vec3 c = max(texture(uSource, vUv).rgb, 0.0);
  vec2 frame = warped((uGeometry * vec3(vUv, 1.0)).xy);
  float hair = clamp(texture(uHair, frame).r, 0.0, 1.0);

  // Where a face was found, the landmarks decide against the hair mask, and they
  // are the sharper of the two by a long way: an outline resolves a face at any
  // size, while the segmentation is 256 pixels across the frame and a head six
  // per cent of it gets a couple of dozen texels. Measured on such a photograph
  // the raw hair mask reads a third of full strength over an iris, which is a
  // tinted eye — and taking the model's own face-skin class out of it moved that
  // by almost nothing, because that class is as coarse as the hair one.
  //
  // Both halves are needed. The skin mask covers the face, but the features are
  // subtracted from it by construction, so on its own it leaves the eyes and the
  // lips unprotected — which is where the measurement found what was left.
  //
  // A fringe survives this. The skin mask has the segmentation's hair taken out
  // of it already, so hair lying over a forehead is not part of it, and the
  // features are the eyes, the brows and the lips rather than the forehead.
  if (uHasFace == 1) {
    vec2 region = toRegion(frame);
    if (inRegion(region)) {
      float face = max(texture(uSkin, region).r, texture(uPoly, region).g);
      hair *= 1.0 - face;
    }
  }

  if (hair <= 0.001) {
    fragColor = vec4(c, 1.0);
    return;
  }

  vec3 mean = texture(uMean, frame).xyz;
  vec3 lab = linearToOklab(c);
  float L = lab.x;
  vec2 ab = lab.yz;

  // A grey strand is lighter than the hair around it and less coloured than it.
  // Either test alone is a highlight, and taking the colour out of a highlight
  // is how hair comes out looking wet.
  if (uGrey > 1e-4) {
    float lighter = smoothstep(0.02, 0.18, L - mean.x);
    float washed = 1.0 - smoothstep(0.35, 0.95, length(ab) / max(length(mean.yz), 1e-3));
    float weight = lighter * washed * hair * uGrey;
    L = mix(L, mean.x, weight * ${GREY_REACH});
    ab = mix(ab, mean.yz, weight);
  }

  // The sheen is the band of light running along the hair, which is whatever is
  // already brighter than its surroundings. It is lifted towards white rather
  // than scaled, so the band gains its light where there is room for it.
  if (uSheen > 1e-4) {
    float band = smoothstep(0.0, 0.12, L - mean.x);
    L += (1.0 - L) * band * hair * uSheen * ${SHEEN_LIFT};
  }

  if (uTint > 1e-4) {
    float h = radians(uTintHue);
    ab += hair * uTint * ${TINT_CHROMA} * vec2(cos(h), sin(h));
  }

  fragColor = vec4(oklabToLinear(vec3(L, ab)), 1.0);
}
`;
