/**
 * The Depth stage: separating the person from the background, and defocusing it.
 *
 * Its place in the order is decided by what a lens is. Defocus happens in the
 * lens, before the film, so it runs before the grade: raising the exposure and
 * then defocusing is not the same picture as defocusing and then raising it,
 * and only the first one is what a camera does.
 *
 * A mask and a Gaussian do not make a lens. Three things separate the two, and
 * all three are here:
 *
 * The convolution is in linear light, which the working space already is. In a
 * gamma space a bright point smears into a dull cloud; in linear light it keeps
 * the energy its area is worth and stays a disc with an edge.
 *
 * Highlights are lifted first. An out-of-focus highlight in a photograph is
 * bright because the sensor saturated there — the file records 1.0 and the
 * scene was several times that — so convolving the recorded value spreads grey.
 * Lifting what is over the threshold before the convolution is the one step
 * that turns a blur into a highlight. Nothing puts it back afterwards: every
 * stage here is scene-referred and the rolloff is applied once, at the end, by
 * the output transform, which is exactly what a camera's own highlight shoulder
 * does to a real one.
 *
 * The kernel has the shape of an aperture rather than of a bell curve, because
 * the shape is what a defocused highlight comes out as.
 */

import { GLSL_COLOR, GLSL_HEADER } from './common';
import { GLSL_WARP } from './face';

/**
 * Taps in the gather, distributed over the aperture by the golden angle.
 *
 * A disc cannot be separated into two passes the way a Gaussian can, so the
 * gather is genuinely two-dimensional and the tap count is the cost. Forty-eight
 * is enough because of what it is reading: the convolution runs at a reduced
 * size chosen so the radius is always about the same handful of texels, so the
 * taps are around two texels apart whatever the slider says, and bilinear
 * filtering covers the gaps. It is also what keeps the cost flat — a radius
 * twice as large is the same forty-eight taps over a smaller picture.
 */
const BOKEH_TAPS = 48;

/** Golden angle in radians: successive taps never line up into spokes. */
const GOLDEN_ANGLE = 2.399963229728653;

/** Aperture shapes, in the order `depth.aperture` declares them. */
export const APERTURE_CIRCLE = 0;
export const APERTURE_HEX = 1;
export const APERTURE_ANAMORPHIC = 2;

/**
 * Lightness at which a pixel starts being treated as a clipped highlight.
 *
 * Below the output transform's own shoulder, so the pixels this lifts are the
 * ones the shoulder was already rolling off — which is another way of saying
 * they are the ones whose recorded value is the least trustworthy.
 */
const BLOOM_THRESHOLD = 0.7;

/** How many times over a fully clipped highlight can be lifted. */
const BLOOM_GAIN = 6.0;

/** How far an anamorphic pupil is squeezed across the frame. */
const ANAMORPHIC_SQUEEZE = 0.55;

/**
 * The separation, before it is refined: the person, and a guide to snap to.
 *
 * The person is the complement of the model's background class rather than the
 * sum of the other five — one fetch instead of five, and it takes the clothes
 * and whatever is being carried with it, which is what has to go out of focus
 * together.
 *
 * Both are read in the photograph's own normalised coordinates, over the whole
 * frame. Unlike the skin mask there is no working area to confine this to: what
 * it divides is the picture.
 */
export const SUBJECT_RAW_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
uniform sampler2D uSegment;
uniform sampler2D uImage;

void main() {
  float person = texture(uSegment, vUv).b;
  // The guide is the photo's own lightness, which is the structure the
  // refinement moves the boundary onto.
  float guide = linearToOklab(max(texture(uImage, vUv).rgb, 0.0)).x;
  fragColor = vec4(person, guide, 0.0, 1.0);
}
`;

/**
 * Lift the highlights, and weight the frame by how much of it is background.
 *
 * The output is premultiplied: the colour is multiplied by the background
 * weight and the weight is carried alongside it. That is not a packing
 * convenience, it is the halo fix. The worst artefact in a defocused
 * background is a rim of light along the subject, and it is the convolution
 * dragging the subject's own pixels outwards that causes it. Premultiplying
 * gives every subject pixel a weight of zero, so the gather below divides by
 * the weight it actually accumulated and a pixel just outside a shoulder
 * averages background only.
 *
 * This is the design's depth-aware gather, written the way a binary separation
 * allows: rejecting samples in front of the centre and giving them zero weight
 * are the same arithmetic, and only the second survives being read at a
 * reduced size — a downsampled depth comparison has already averaged the two
 * sides of the boundary together and has nothing left to compare.
 *
 * The mask is sampled through the framing matrix and then the displacement, in
 * that order and for the same reason the skin stages do it: it was built in the
 * photograph's own frame, before anything was cropped or reshaped.
 */
export const BOKEH_LIFT_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_WARP}
uniform sampler2D uSource;
uniform sampler2D uSubject;
uniform mat3 uGeometry;
uniform float uBloom;

const float BLOOM_THRESHOLD = ${BLOOM_THRESHOLD.toFixed(4)};
const float BLOOM_GAIN = ${BLOOM_GAIN.toFixed(4)};

void main() {
  vec3 colour = texture(uSource, vUv).rgb;
  float subject = clamp(texture(uSubject, warped((uGeometry * vec3(vUv, 1.0)).xy)).r, 0.0, 1.0);
  float background = 1.0 - subject;

  float over = max(luma(colour) - BLOOM_THRESHOLD, 0.0) / max(1.0 - BLOOM_THRESHOLD, 1e-4);
  float lift = 1.0 + uBloom * BLOOM_GAIN * over;

  fragColor = vec4(colour * lift * background, background);
}
`;

/**
 * The convolution: an aperture-shaped gather over the premultiplied frame.
 *
 * Two normalisations come out of one loop and they answer different questions.
 * The colour is the total divided by the weight that was found, which is the
 * average of the background the kernel reached — correct right up against a
 * shoulder, where most of the kernel is subject. The alpha is the weight
 * divided by the number of taps, which is how much background there was to
 * average; where it is nothing, there is no background colour to report and the
 * stage downstream keeps what it had.
 *
 * Taps are laid out by the golden angle over the unit disc and the aperture
 * then reshapes that disc, rather than the disc being sampled and taps outside
 * the shape discarded. Discarding would spend the tap budget on the corners of
 * a hexagon and thin out its middle.
 *
 * The cat's eye is the one place this stops being a convolution. Mechanical
 * vignetting is the barrel cutting into the light path off-axis, and it is
 * modelled here as a second disc, offset outwards in proportion to how far the
 * pixel is from the middle of the frame, that taps have to fall inside. It is
 * an approximation of the effect rather than a derivation from a pupil, and it
 * is the difference between a rendered background and a photographed one.
 */
export const BOKEH_GATHER_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D uSource;
uniform vec2 uRadius;
uniform int uAperture;
uniform float uCatsEye;
uniform float uAspect;

const int BOKEH_TAPS = ${BOKEH_TAPS};
const float GOLDEN_ANGLE = ${GOLDEN_ANGLE.toFixed(9)};
const float ANAMORPHIC_SQUEEZE = ${ANAMORPHIC_SQUEEZE.toFixed(4)};
const int APERTURE_HEX = ${APERTURE_HEX};
const int APERTURE_ANAMORPHIC = ${APERTURE_ANAMORPHIC};

// Boundary of a regular hexagon of circumradius 1, at one angle.
float hexReach(float angle) {
  float wedge = mod(angle, 1.047197551);
  return 0.866025404 / cos(wedge - 0.523598776);
}

void main() {
  // Nothing is being defocused, and the background adjustments still want the
  // frame. Undoing the premultiplication rather than passing it on, so what
  // comes out of here means the same thing at every setting.
  if (uRadius.x <= 0.0) {
    vec4 here = texture(uSource, vUv);
    fragColor = vec4(here.rgb / max(here.a, 1e-4), here.a);
    return;
  }

  // Outwards from the middle of the frame, isotropically, which is the
  // direction the barrel clips from.
  vec2 offAxis = vec2(vUv.x - 0.5, (vUv.y - 0.5) * uAspect);
  float extent = 0.5 * sqrt(1.0 + uAspect * uAspect);
  vec2 away = length(offAxis) > 1e-5 ? offAxis / length(offAxis) : vec2(0.0);
  float clipped = uCatsEye * clamp(length(offAxis) / extent, 0.0, 1.0);

  vec4 total = vec4(0.0);
  float taps = 0.0;

  for (int i = 0; i < BOKEH_TAPS; i++) {
    float t = (float(i) + 0.5) / float(BOKEH_TAPS);
    float angle = float(i) * GOLDEN_ANGLE;
    vec2 unit = sqrt(t) * vec2(cos(angle), sin(angle));

    if (uAperture == APERTURE_HEX) unit *= hexReach(angle);
    if (uAperture == APERTURE_ANAMORPHIC) unit.x *= ANAMORPHIC_SQUEEZE;

    taps += 1.0;
    if (length(unit - away * clipped) > 1.0) continue;
    total += texture(uSource, vUv + unit * uRadius);
  }

  vec3 colour = total.rgb / max(total.a, 1e-4);
  fragColor = vec4(colour, total.a / max(taps, 1.0));
}
`;

/**
 * Put the defocused background back behind the person.
 *
 * The brightness and saturation go on here rather than before the convolution,
 * because they are not light: darkening a background to lift a subject off it
 * is a decision about the picture, and a decision does not belong on the
 * scene side of a lens. They are also confined to the background by the same
 * mask that decides the defocus, so the person is untouched by both.
 *
 * Where the gather found no background at all — deep inside the subject, where
 * every tap it took was subject too — there is no colour to report and the
 * sharp frame stands in. Those pixels are weighted out by the mask a line
 * later, but a black one would show through a soft edge.
 */
export const BOKEH_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_WARP}
uniform sampler2D uSource;
uniform sampler2D uBokeh;
uniform sampler2D uSubject;
uniform mat3 uGeometry;
uniform float uBrightness;
uniform float uSaturation;

void main() {
  vec3 sharp = texture(uSource, vUv).rgb;
  vec4 gathered = texture(uBokeh, vUv);
  float subject = clamp(texture(uSubject, warped((uGeometry * vec3(vUv, 1.0)).xy)).r, 0.0, 1.0);

  vec3 background = gathered.a > 1e-3 ? gathered.rgb : sharp;
  vec3 lab = linearToOklab(max(background, 0.0));
  lab.x = max(lab.x * (1.0 + uBrightness * 0.5), 0.0);
  lab.yz *= max(1.0 + uSaturation, 0.0);
  background = oklabToLinear(lab);

  fragColor = vec4(mix(background, sharp, subject), 1.0);
}
`;
