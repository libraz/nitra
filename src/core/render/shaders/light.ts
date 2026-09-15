/**
 * The Relight stage: one light, added to the one that was in the room.
 *
 * It runs after the skin and before the grade, and both halves of that matter.
 * After the skin, because smoothing the face first means the light lands on a
 * smooth surface — the other way round, the gradient the light adds is itself
 * something for the filter to even out. Before the grade, because adding light
 * is a scene-referred operation and grading is a display-referred one; graded
 * first, an exposure correction would be undoing the light that had just been
 * added to the picture.
 *
 * What keeps it from falling apart is that it only ever *adds*. The photograph's
 * own lighting is unknown and unrecoverable — separating what the light did from
 * what the skin is would be reflectance estimation, which is the stage beyond
 * this one and the one that breaks. A light that is only added cannot contradict
 * the one already there; it can only be too strong, and how strong it is is the
 * slider.
 *
 * The light is applied as a gain rather than as a sum, which is the one place
 * this departs from the design memo's formula, and it is a departure in the
 * memo's own direction. What the memo relies on is adding rather than
 * subtracting, and a gain of one plus something positive adds. What a sum costs
 * is texture: the recorded value is the skin's reflectance times the light that
 * fell on it, so adding a constant to a pore and to the skin beside it narrows
 * the difference between them — the whole face comes out flatter, in the one
 * pipeline whose every other stage is arranged around not flattening it. A gain
 * multiplies both and the ratio between them survives. It also makes the amount
 * relative, as every amount here has to be: a tenth more light is a tenth more
 * light on a dark photograph and a bright one, where adding 0.1 is most of the
 * picture on one and nothing on the other.
 */

import { GLSL_COLOR, GLSL_HEADER } from './common';
import { GLSL_REGION, GLSL_WARP } from './face';

/**
 * How much light the top of the slider adds, as a fraction of what is there.
 *
 * The bound on the whole stage. At the top of the range the lit side of the face
 * comes up by this much and the unlit side by nothing, which is about as far as
 * a face can be relit before the result stops being a photograph of the light
 * that was in the room — and the guardrails have no reading for that, so the
 * range is where it is said.
 */
const LIGHT_GAIN = 0.6;

/**
 * How far the warmth control moves the light's colour, in Oklab chroma.
 *
 * Small, because this is the colour of a light and not a colour cast: a lamp is
 * warm against daylight by a few per cent of chroma, and anything a person would
 * call orange is a stage effect rather than a light somebody could have brought
 * into the room.
 */
const LIGHT_CHROMA = 0.03;

/** The hue the warm end of the control tints towards, in Oklab degrees. */
const WARM_HUE = 70;

/**
 * Shade the face with one added light.
 *
 * The normal field is sampled through the same working area as the masks, and
 * through the same displacement: a reshaped face has moved, and reading the
 * normal where the pixel is rather than where its content came from would put
 * the whole of the shading a face-width away from the face.
 *
 * Where the light reaches is the normal field's own alpha and nothing else. It
 * says how much of the mesh reached the pixel, which is the same question as
 * whether there is a surface here to shade, and it is smooth by construction —
 * one landmark's contribution goes to zero with zero slope at the edge of its
 * reach, so the field fades out over the outer part of a reach rather than
 * stopping.
 *
 * Confining it to the face outline instead was tried and is wrong twice over.
 * The outline is a polygon, so its coverage is antialiased but not feathered:
 * one pixel of transition at the mask's own resolution, which magnified to the
 * frame is a hard edge, and a step in brightness across a forehead reads as a
 * shape cut out of the picture rather than as light. And it stops at the jaw,
 * where a light does not — spilling a little onto the hair and the neck is what
 * a light in a room does.
 */
export const RELIGHT_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_REGION}
${GLSL_WARP}
uniform sampler2D uSource;
uniform sampler2D uNormals;
uniform mat3 uGeometry;

uniform vec3 uLight;
uniform float uIntensity;
uniform float uSharpness;
uniform float uWarmth;

void main() {
  vec3 c = max(texture(uSource, vUv).rgb, 0.0);
  vec2 region = toRegion(warped((uGeometry * vec3(vUv, 1.0)).xy));
  if (!inRegion(region)) {
    fragColor = vec4(c, 1.0);
    return;
  }
  vec4 packed = texture(uNormals, region);
  float face = packed.w;
  if (face <= 0.001) {
    fragColor = vec4(c, 1.0);
    return;
  }

  // Half-Lambert rather than Lambert: the shaded side falls to a quarter rather
  // than to black, which is both what skin does — light goes into it and comes
  // back out somewhere else — and what stops the terminator from being a line.
  vec3 normal = normalize(packed.xyz * 2.0 - 1.0);
  float lit = pow(dot(normal, uLight) * 0.5 + 0.5, uSharpness);
  float gain = lit * uIntensity * ${LIGHT_GAIN.toFixed(3)} * face;

  vec3 lab = linearToOklab(c);
  // The colour of the light rides on how much of it landed, so an unlit cheek
  // does not pick up the warmth of a light that never reached it.
  float h = radians(${WARM_HUE.toFixed(1)});
  vec2 tint = uWarmth * gain * ${LIGHT_CHROMA.toFixed(3)} * vec2(cos(h), sin(h));
  fragColor = vec4(oklabToLinear(vec3(lab.x, lab.yz + tint)) * (1.0 + gain), 1.0);
}
`;
