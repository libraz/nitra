/**
 * The face stages: the skin mask, the skin itself, and the parts.
 *
 * Their place in the order is not negotiable. Skin runs before the grade
 * because smoothing is a statement about the surface light fell on, and the
 * grade is a statement about the light; smoothing a graded photo smooths the
 * grade's own gradients. Parts run after skin so lip colour is not smeared by
 * the filter that just went over the face.
 *
 * Everything is measured against the width of the face rather than the width of
 * the image. A radius of three per cent of a face is the same retouch whether
 * the face fills the frame or a tenth of it; three per cent of the image is two
 * different ones.
 *
 * The heavy lifting is a guided filter, not a blur. A blur cannot tell a pore
 * from an edge, so it takes both, and taking both is what plastic skin is. The
 * guided filter keeps the edges and the high frequency it leaves behind is the
 * texture, which is then put back in whatever proportion was asked for.
 */

import { MAX_CONTROL_POINTS } from '../../face/warp';
import { GLSL_COLOR, GLSL_HEADER } from './common';

/**
 * Mapping between the frame and the working area the face masks live in.
 *
 * The masks are not built over the whole photo. A face six per cent of the
 * width of a large photograph is still hundreds of pixels of face, and
 * spreading the mask over the frame at any affordable size leaves it with a few
 * dozen — which is visible on the result as blotches, because a coarse mask
 * magnified back up is a coarse mask. Confined to the faces, the same budget
 * resolves them at full size.
 *
 * `uRegion` is that rectangle in normalised image coordinates. Every stage that
 * reads a mask goes through `toRegion` and checks the result is inside: outside
 * the working area there is no mask, which is a different thing from the
 * nearest edge of one.
 *
 * Exported because the hair stage reads the skin mask too — it works over the
 * whole frame but has to know where the face is, so it needs both mappings.
 */
export const GLSL_REGION = `
uniform vec4 uRegion;

vec2 toRegion(vec2 frame) {
  return (frame - uRegion.xy) / uRegion.zw;
}
vec2 fromRegion(vec2 region) {
  return uRegion.xy + region * uRegion.zw;
}
bool inRegion(vec2 uv) {
  return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}
`;

/**
 * Following the reshaping, for everything that reads a mask.
 *
 * The masks and the filter coefficients are built in the photograph's own frame
 * and know nothing about a displacement. Once the face has been moved, the pixel
 * a stage is looking at came from somewhere else in that frame, and reading the
 * mask where the pixel *is* would put the mask a face-width away from the face —
 * the smoothing would run off the jaw on one side and stop short on the other.
 *
 * So every stage that samples a mask goes from the frame through here first. The
 * field holds the offset back to where the content was read from, which is the
 * same offset the resampling used, so one texture serves both and they cannot
 * disagree about where the face went.
 *
 * `uWarped` is zero when nothing is being reshaped, and then this is the
 * identity. It has to be a uniform rather than an absent texture because a
 * sampler that is never bound still reads, and what it reads is not zero.
 *
 * Exported because the background separation is built in that same unwarped
 * frame and has to follow the displacement for the same reason. One copy, so
 * the two cannot end up disagreeing about where the face went.
 */
export const GLSL_WARP = `
uniform sampler2D uWarp;
uniform int uWarped;

vec2 warped(vec2 frame) {
  if (uWarped == 0) return frame;
  return frame + texture(uWarp, frame).xy;
}
`;

/**
 * The displacement field, over the photograph's own frame.
 *
 * Each control point says the face at its centre moves by its delta, fading to
 * nothing at its radius. What is written here is the opposite of that: the
 * offset back to where a pixel should be read from, because resampling asks
 * where content came from rather than where it went. The negation happens once,
 * here, and `warp.ts` carries the deltas the way a person would describe them.
 *
 * The deltas are averaged and the average is then faded, which is two steps
 * because neither one alone is a field.
 *
 * Summing the contributions would move the middle of a cheek by the total of
 * every pull that reaches it, an amount bounded by nothing in particular.
 * Averaging bounds it by the largest single delta — but an average alone has no
 * falloff at all: with one control point, the weight cancels between the
 * numerator and the denominator, so the displacement is its full delta
 * everywhere inside the support and zero immediately outside. That step is a
 * tear in the picture, and it is what this looked like when it was measured.
 *
 * So the average decides the direction and magnitude, and the largest weight
 * reaching the pixel fades it out: one at a control point's own centre, zero
 * where every support has ended, smooth in between. Opposed deltas still cancel
 * through the average, which is what keeps an eye growing instead of sliding.
 *
 * The weights are evaluated at the destination rather than at the source, which
 * is the usual approximation for inverting a small displacement: it is exact in
 * the limit and understates the movement slightly at the top of a slider. The
 * error is smooth, so it costs a little of the effect rather than showing up as
 * a seam.
 *
 * Distances are isotropic, in units of the image's width, so a radius is a
 * circle on a photograph that is not square.
 */
export const FACE_WARP_FIELD_FRAGMENT = `${GLSL_HEADER}
uniform vec4 uPoint[${MAX_CONTROL_POINTS}];
uniform vec4 uDelta[${MAX_CONTROL_POINTS}];
uniform int uCount;
uniform float uAspect;

void main() {
  vec2 here = vec2(vUv.x, vUv.y * uAspect);
  vec2 sum = vec2(0.0);
  float weight = 0.0;
  float peak = 0.0;

  for (int i = 0; i < ${MAX_CONTROL_POINTS}; i++) {
    if (i >= uCount) break;
    float radius = uPoint[i].z;
    float distance = length(here - uPoint[i].xy);
    if (distance >= radius) continue;
    // Smooth at both ends: a linear falloff leaves a crease at the centre of
    // every control point, and a crease in a displacement is a visible kink in
    // whatever was straight there.
    float t = distance / radius;
    float w = 1.0 - t * t * (3.0 - 2.0 * t);
    sum += uDelta[i].xy * w;
    weight += w;
    peak = max(peak, w);
  }

  vec2 delta = weight > 0.0 ? (sum / weight) * peak : vec2(0.0);
  fragColor = vec4(-delta.x, -delta.y / uAspect, 0.0, 1.0);
}
`;

/**
 * The photograph, resampled through the displacement field.
 *
 * Reads the source rather than the ingested frame. Resampling something that
 * was already resampled costs a visible amount of sharpness at proxy sizes, and
 * there is no reason to pay it: the framing is a matrix and the displacement is
 * a field, so the two compose into one lookup.
 *
 * Kept apart from the ingest pass on purpose, rather than ingest gaining a
 * displacement of its own. `ingest` is what the photograph looked like before
 * anything was done to it, which is what the before-and-after view shows and
 * what the texture measurement compares against. A reshaping inside it would
 * quietly redefine both.
 */
export const FACE_WARP_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_WARP}
uniform sampler2D uSource;
uniform mat3 uGeometry;
uniform int uFromSrgb;

void main() {
  vec2 uv = warped((uGeometry * vec3(vUv, 1.0)).xy);
  vec3 c = max(texture(uSource, uv).rgb, 0.0);
  if (uFromSrgb == 1) c = SRGB_TO_P3 * c;
  fragColor = vec4(c, 1.0);
}
`;

/**
 * Lightness and chroma over the working area, at reduced resolution.
 *
 * The filter is computed small and applied full size — its coefficients vary
 * slowly by construction, so nothing is lost, and it makes the cost independent
 * of whether the photo is a proxy or twelve megapixels. It also makes the
 * result the same at both, which matters more: a preview that smooths
 * differently from the export is a preview that lies.
 *
 * Lightness carries the texture, so it gets the filter. Colour does not — skin
 * blotchiness is slow variation in chroma and the eye cannot resolve a chroma
 * edge anyway — so a and b are simply averaged alongside.
 *
 * Averaging this gives the window means, and the deviation pass below turns
 * those into the variance. Squaring here instead, the textbook way, does not
 * survive the precision the intermediates are held at: see {@link
 * FACE_DEVIATION_FRAGMENT}.
 */
export const FACE_MEAN_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_REGION}
uniform sampler2D uSource;
uniform int uFromSrgb;

void main() {
  vec3 c = max(texture(uSource, fromRegion(vUv)).rgb, 0.0);
  if (uFromSrgb == 1) c = SRGB_TO_P3 * c;
  vec3 lab = linearToOklab(c);
  fragColor = vec4(lab.x, lab.y, lab.z, 1.0);
}
`;

/**
 * Squared deviation from the window mean, which averages into the variance.
 *
 * Two passes for one number, and the reason is precision rather than taste.
 * `E[L²] − E[L]²` is the difference of two quantities that are nearly equal:
 * skin sits near seven tenths in Oklab lightness, so both terms are around a
 * half, while the variance being extracted from them is a few ten-thousandths.
 * Half-float steps by about five ten-thousandths at that magnitude, so the
 * subtraction has as much quantisation in it as answer — and because the
 * negative half of that error is clamped away, what survives is biased upward.
 * A filter reading it decides the skin is an edge and returns the photograph.
 *
 * Squaring the deviation instead keeps every term at the size of the answer,
 * where the same sixteen bits have all their precision available.
 */
export const FACE_DEVIATION_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_REGION}
uniform sampler2D uSource;
uniform sampler2D uMean;
uniform int uFromSrgb;

void main() {
  vec3 c = max(texture(uSource, fromRegion(vUv)).rgb, 0.0);
  if (uFromSrgb == 1) c = SRGB_TO_P3 * c;
  float d = linearToOklab(c).x - texture(uMean, vUv).x;
  fragColor = vec4(d * d, 0.0, 0.0, 1.0);
}
`;

/**
 * Separable box blur with a radius set at draw time.
 *
 * A box is what the guided filter is defined over, and running it separably
 * makes the cost linear in the radius rather than quadratic. The taps are
 * counted rather than weighted on purpose: this is an averaging window, not a
 * Gaussian, and weighting it would change what the filter is.
 */
export const BOX_BLUR_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D uSource;
uniform vec2 uStep;
uniform int uRadius;

void main() {
  vec4 sum = vec4(0.0);
  float count = 0.0;
  for (int i = -64; i <= 64; i++) {
    if (i < -uRadius || i > uRadius) continue;
    sum += texture(uSource, vUv + uStep * float(i));
    count += 1.0;
  }
  fragColor = sum / max(count, 1.0);
}
`;

/**
 * Turn the averaged statistics into the guided filter's own coefficients.
 *
 * `a` is how much of the local detail survives, which is the variance of the
 * window against itself plus a regularisation term; `b` is what is left to add
 * so that a flat window comes back unchanged. Where the window is flat — skin —
 * `a` goes to zero and the filter returns the local mean. Where it straddles an
 * edge, `a` goes to one and the filter returns the photo. That is the whole
 * reason an eyelash survives this and a pore does not.
 */
export const FACE_COEFF_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D uMean;
uniform sampler2D uVariance;
uniform float uEpsilon;

void main() {
  float meanL = texture(uMean, vUv).x;
  float variance = max(texture(uVariance, vUv).x, 0.0);
  float a = variance / (variance + uEpsilon);
  fragColor = vec4(a, meanL - a * meanL, 0.0, 1.0);
}
`;

/**
 * Intersect the outline with the segmentation, and pack the guide alongside.
 *
 * The outline says where a face is; the segmentation says which of those pixels
 * are the skin of it rather than the hair over it or the background behind the
 * jaw. Neither is enough alone: the outline is a polygon over a head that has
 * hair in front of it, and the segmentation is a 256-pixel guess with no idea
 * where an eyebrow is.
 *
 * Body skin is deliberately not part of this. A shoulder is skin, and smoothing
 * it because a face is being smoothed is not what the slider says.
 *
 * The intersection is weighted, because the two can disagree and it is almost
 * always the segmentation that is wrong: one network with one opinion against
 * 478 points that agreed with each other. Intersecting anyway would produce an
 * empty mask, and every skin control would then move and do nothing.
 */
export const FACE_MASK_RAW_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_REGION}
uniform sampler2D uPoly;
uniform sampler2D uSegment;
uniform sampler2D uImage;
uniform float uSegmentWeight;

void main() {
  vec2 frame = fromRegion(vUv);
  vec2 poly = texture(uPoly, vUv).rg;
  vec2 seg = texture(uSegment, frame).rg;
  float refined = mix(1.0, seg.r * (1.0 - seg.g), uSegmentWeight);
  float raw = poly.r * (1.0 - poly.g) * refined;
  // The guide is the photo's own lightness, which is what the refinement below
  // snaps the mask's edges onto.
  float guide = linearToOklab(max(texture(uImage, frame).rgb, 0.0)).x;
  fragColor = vec4(raw, guide, 0.0, 1.0);
}
`;

/**
 * Deviations from the window means, for the mask's own guided filter.
 *
 * Averaged, these are the variance of the guide and its covariance with the
 * mask. Both are computed from deviations rather than from raw second moments
 * for the reason {@link FACE_DEVIATION_FRAGMENT} gives — here the cancellation
 * is worse, since the covariance subtracts two products of numbers near one and
 * what is left over is the small correlation between a soft mask edge and a
 * lightness edge, which is the entire signal the refinement runs on.
 */
export const FACE_MASK_DEVIATION_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D uSource;
uniform sampler2D uMean;

void main() {
  vec2 value = texture(uSource, vUv).rg;
  vec2 mean = texture(uMean, vUv).rg;
  float dp = value.r - mean.r;
  float di = value.g - mean.g;
  fragColor = vec4(di * di, di * dp, 0.0, 1.0);
}
`;

/** The joint-upsampling coefficients: the same filter, with two signals. */
export const FACE_MASK_COEFF_FRAGMENT = `${GLSL_HEADER}
uniform sampler2D uMean;
uniform sampler2D uDeviation;
uniform float uEpsilon;

void main() {
  vec2 mean = texture(uMean, vUv).rg;
  vec2 dev = texture(uDeviation, vUv).rg;
  float variance = max(dev.x, 0.0);
  float a = dev.y / (variance + uEpsilon);
  fragColor = vec4(a, mean.r - a * mean.g, 0.0, 1.0);
}
`;

/**
 * Apply the refined mask and feather it.
 *
 * The feather is the last thing that happens to the mask and the first thing
 * anyone would notice going wrong: a hard edge puts a visible seam along the
 * jaw, and too soft an edge lets the effect onto the background. It is a
 * fraction of the face width, so it stays the same feather on the next photo.
 */
export const FACE_MASK_APPLY_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_REGION}
uniform sampler2D uCoeff;
uniform sampler2D uImage;

void main() {
  vec2 ab = texture(uCoeff, vUv).rg;
  float guide = linearToOklab(max(texture(uImage, fromRegion(vUv)).rgb, 0.0)).x;
  fragColor = vec4(clamp(ab.x * guide + ab.y, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

/**
 * Skin: frequency separation, colour evening and specular reduction.
 *
 * The three are one pass because they all want the same two things — the
 * edge-preserving low frequency and a wider average of it — and computing those
 * twice would be both slower and a second place for them to disagree.
 *
 * Shine is reduced towards the surrounding skin rather than towards grey. A
 * specular highlight is the light source reflected off oil, so what belongs
 * there is the skin it is sitting on: pulling it towards the local average
 * leaves the shape of the face, while pulling it towards a neutral flattens the
 * forehead into a patch. It is also never taken all the way, because a face
 * with no highlight at all reads as a drawing.
 */
export const FACE_SKIN_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_REGION}
${GLSL_WARP}
uniform sampler2D uSource;
uniform sampler2D uCoeff;
uniform sampler2D uMean;
uniform sampler2D uWideMean;
uniform sampler2D uMask;
uniform mat3 uGeometry;

uniform float uSmooth;
uniform float uBlemish;
uniform float uTexture;
uniform float uShine;
uniform float uTone;

void main() {
  vec3 c = max(texture(uSource, vUv).rgb, 0.0);
  // Into the source's frame, then into the working area the masks and the
  // filter coefficients live in. Outside it there is no face to work on.
  vec2 region = toRegion(warped((uGeometry * vec3(vUv, 1.0)).xy));
  if (!inRegion(region)) {
    fragColor = vec4(c, 1.0);
    return;
  }
  float mask = texture(uMask, region).r;
  if (mask <= 0.001) {
    fragColor = vec4(c, 1.0);
    return;
  }

  vec4 coeff = texture(uCoeff, region);
  vec3 mean = texture(uMean, region).xyz;
  vec3 wide = texture(uWideMean, region).xyz;
  vec3 lab = linearToOklab(c);
  float L = lab.x;
  vec2 ab = lab.yz;
  vec2 wideAb = wide.yz;

  // The edge-preserving low frequency, and what the photo has above it.
  float low = coeff.x * L + coeff.y;
  float high = L - low;
  // Slow variation within the low frequency: the blotchiness, as distinct from
  // the shading, which is slower still and lives in the wider average.
  //
  // Both terms are window means of lightness. The filter's own offset is the
  // obvious thing to reach for here and is the wrong thing: it carries a factor
  // of one minus the filter's slope, so it collapses towards zero wherever the
  // filter has decided it is looking at an edge. Differenced against a wider
  // average of itself, that collapse reads as enormous blotchiness along every
  // eyelid and lip — and subtracting it darkens exactly the places the filter
  // was protecting.
  float blotch = mean.x - wide.x;

  // How much texture survives, and how hard the blotches are pushed. The
  // master amount drives both; the two trims move each on its own, and with all
  // three at zero this collapses to the photo exactly.
  float keep = max(1.0 - uSmooth + uTexture, 0.0);
  float even = clamp(uSmooth * 0.7 + uBlemish, 0.0, 1.0);

  float smoothed = (low - blotch * even) + high * keep;
  vec2 smoothedAb = mix(ab, wideAb, even);
  L = mix(L, smoothed, mask);
  ab = mix(ab, smoothedAb, mask);

  // Colour evening, which is its own control: skin can be blotchy in colour
  // while its texture is exactly what somebody wants to keep.
  ab = mix(ab, wideAb, uTone * mask);

  if (uShine > 1e-4) {
    // Bright for its surroundings and less coloured than them: that pair is
    // what a reflection off skin looks like, and either alone is not.
    float above = (L - wide.x) / max(wide.x, 0.05);
    float localChroma = length(wideAb);
    float chroma = length(ab);
    float bright = smoothstep(0.10, 0.45, above);
    float washed = 1.0 - smoothstep(0.35, 0.95, chroma / max(localChroma, 1e-3));
    float spec = bright * washed * mask * uShine;
    L = mix(L, mix(L, wide.x, 0.85), spec);
    ab = mix(ab, wideAb, spec * 0.7);
  }

  fragColor = vec4(oklabToLinear(vec3(L, ab)), 1.0);
}
`;

/**
 * Parts: the eyes, the iris, the teeth, the lips, the cheeks and the shadow
 * under an eye.
 *
 * Each one is a coverage channel from the landmark outlines, narrowed by what
 * the pixel actually is. The outline of an eye contains the iris as well as the
 * white of it, and whitening the iris is how an edit stops looking like a
 * photograph — so the brightness and the chroma decide, with the outline only
 * saying where to look.
 *
 * Colour is added as Oklab chroma at a fixed hue, the same way split toning
 * adds it, which leaves the lightness where the photo had it. Lipstick that
 * also brightens the lip reads as a sticker.
 */
export const FACE_PARTS_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_REGION}
${GLSL_WARP}
uniform sampler2D uSource;
uniform sampler2D uPolyA;
uniform sampler2D uPolyB;
uniform sampler2D uMask;
uniform sampler2D uMean;
uniform sampler2D uWideMean;
uniform mat3 uGeometry;

uniform float uUndereye;
uniform float uEyes;
uniform float uIris;
uniform float uCatchlight;
uniform float uTeeth;
uniform float uLip;
uniform float uLipHue;
uniform float uCheek;
uniform float uCheekHue;

void main() {
  vec3 c = max(texture(uSource, vUv).rgb, 0.0);
  vec2 region = toRegion(warped((uGeometry * vec3(vUv, 1.0)).xy));
  if (!inRegion(region)) {
    fragColor = vec4(c, 1.0);
    return;
  }
  vec4 polyA = texture(uPolyA, region);
  vec4 polyB = texture(uPolyB, region);
  float skin = texture(uMask, region).r;

  float anywhere = polyA.b + polyA.a + polyB.r + polyB.g + polyB.b + polyB.a;
  if (anywhere <= 0.001) {
    fragColor = vec4(c, 1.0);
    return;
  }

  vec3 wide = texture(uWideMean, region).xyz;
  vec3 lab = linearToOklab(c);
  float L = lab.x;
  vec2 ab = lab.yz;

  // Under the eye: the shadow is slow variation that is darker than the wider
  // average of the same skin, so lifting by exactly that difference takes the
  // shadow out and leaves everything else — including the eyelashes, which are
  // not slow variation at all.
  if (uUndereye > 1e-4) {
    float weight = polyB.g * skin * uUndereye;
    L += max(wide.x - L, 0.0) * weight * 0.8;
  }

  // The white of the eye, and teeth: both are the bright, barely coloured part
  // inside an outline that also contains something that must not be touched.
  float chroma = length(ab);
  float pale = smoothstep(0.30, 0.62, L) * (1.0 - smoothstep(0.02, 0.09, chroma));
  float sclera = polyB.r * pale * uEyes;
  float teeth = polyA.a * pale * uTeeth;
  float whiten = clamp(sclera + teeth, 0.0, 1.0);
  if (whiten > 1e-4) {
    ab *= 1.0 - whiten * 0.75;
    L += (1.0 - L) * whiten * 0.12;
  }

  // The iris, where the fitted circle and the eye opening agree. Both are
  // needed: the circle reaches under the eyelid, and the opening contains the
  // white of the eye as well.
  float iris = polyB.a * polyB.r;
  if (iris > 1e-3 && max(uIris, uCatchlight) > 1e-4) {
    // Against a local average of the photograph rather than a fixed pivot, so
    // what is expanded is the pattern in this iris and the ring at its edge,
    // and a light eye does not come out darker than it was.
    float detail = L - texture(uMean, region).x;
    L += detail * iris * (1.0 - pale) * uIris * 0.9;
    // The catchlight is the one thing in an iris far above its own average, so
    // it needs no mask of its own — and it must not be excluded as the white of
    // the eye is, which is the one place the pale test would be wrong here.
    L += (1.0 - L) * smoothstep(0.05, 0.16, detail) * iris * uCatchlight * 0.5;
  }

  if (uLip > 1e-4) {
    float weight = polyA.b * uLip;
    float h = radians(uLipHue);
    ab += weight * 0.09 * vec2(cos(h), sin(h));
  }

  if (uCheek > 1e-4) {
    float weight = polyB.b * skin * uCheek;
    float h = radians(uCheekHue);
    ab += weight * 0.045 * vec2(cos(h), sin(h));
  }

  fragColor = vec4(oklabToLinear(vec3(L, ab)), 1.0);
}
`;

/**
 * How much of the skin's texture is still there.
 *
 * The one guardrail that needs two pictures rather than one: the high frequency
 * inside the skin mask, after the face stages, over what the photo arrived
 * with. It is measured rather than inferred from the slider, so it stays honest
 * as stages are added — and so the number means the skin, not the sharpening
 * that happened somewhere else in the frame.
 *
 * The ratio is formed per pixel and weighted by how much texture there was to
 * lose. A flat patch of cheek has no texture either way and no opinion about
 * whether it was kept.
 */
export const FACE_TEXTURE_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_REGION}
${GLSL_WARP}
uniform sampler2D uBefore;
uniform sampler2D uAfter;
uniform sampler2D uMask;
uniform mat3 uGeometry;
uniform vec2 uStep;

float detail(sampler2D image, vec2 uv) {
  float centre = linearToOklab(max(texture(image, uv).rgb, 0.0)).x;
  float around = (
    linearToOklab(max(texture(image, uv + vec2(uStep.x, 0.0)).rgb, 0.0)).x +
    linearToOklab(max(texture(image, uv - vec2(uStep.x, 0.0)).rgb, 0.0)).x +
    linearToOklab(max(texture(image, uv + vec2(0.0, uStep.y)).rgb, 0.0)).x +
    linearToOklab(max(texture(image, uv - vec2(0.0, uStep.y)).rgb, 0.0)).x
  ) * 0.25;
  return abs(centre - around);
}

void main() {
  vec2 region = toRegion(warped((uGeometry * vec3(vUv, 1.0)).xy));
  float mask = inRegion(region) ? texture(uMask, region).r : 0.0;
  float before = detail(uBefore, vUv);
  float after = detail(uAfter, vUv);
  float weight = mask * smoothstep(0.0, 0.004, before);
  float ratio = clamp(after / max(before, 1e-4), 0.0, 1.0);
  fragColor = vec4(weight * ratio, weight, 0.0, 1.0);
}
`;

/**
 * What the skin looks like, as numbers, for the automatic starting values.
 *
 * Three things the sliders cannot be set from the whole frame: how bright the
 * skin is, how uneven it is, and how much of it is reflecting the light source.
 * The frame's own histogram answers none of them — a backlit face in a bright
 * room is a correctly exposed photograph of an underexposed person.
 *
 * `uSurround` runs the same sums over everything that is not skin, which is the
 * other half of the backlit question: a face is not dark, it is dark *for what
 * is behind it*, and one number without the other cannot say that.
 */
export const FACE_PROBE_FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
${GLSL_REGION}
${GLSL_WARP}
uniform sampler2D uSource;
uniform sampler2D uMask;
uniform sampler2D uMean;
uniform sampler2D uWideMean;
uniform mat3 uGeometry;
uniform int uSurround;

void main() {
  vec2 region = toRegion(warped((uGeometry * vec3(vUv, 1.0)).xy));
  bool here = inRegion(region);
  float mask = here ? texture(uMask, region).r : 0.0;
  float weight = uSurround == 1 ? 1.0 - mask : mask;
  vec3 lab = linearToOklab(max(texture(uSource, vUv).rgb, 0.0));
  vec2 probeAt = here ? region : vec2(0.5);
  vec3 mean = texture(uMean, probeAt).xyz;
  vec3 wide = texture(uWideMean, probeAt).xyz;

  // Unevenness is the slow variation in the skin's own lightness: the local
  // average against a wider one, which is the same difference the skin stage
  // evens out. Measured on lightness rather than on the filter's coefficients,
  // which collapse at every edge and would report a clean face as a blotchy one.
  //
  // The gain is what makes the reading mean something, and it cannot be picked
  // for a full range: this difference is also where the form of a face lives —
  // the side of the nose, the cheekbone, the temple — so even unblemished skin
  // reads a few per cent of lightness here and no gain separates the two. It is
  // set from measured skin so that a clean face reads low rather than zero,
  // which is the honest answer, and leaves the top of the range for skin that is
  // several times less even than that.
  float blotch = abs(mean.x - wide.x) * 7.0;
  // Chroma wandering away from the local average is the colour half of it.
  float drift = length(lab.yz - wide.yz) * 14.0;
  float uneven = clamp(max(blotch, drift), 0.0, 1.0);

  float above = (lab.x - wide.x) / max(wide.x, 0.05);
  float washed = 1.0 - smoothstep(0.35, 0.95, length(lab.yz) / max(length(wide.yz), 1e-3));
  float spec = smoothstep(0.18, 0.50, above) * washed;

  fragColor = vec4(weight * lab.x, weight * uneven, weight * spec, weight);
}
`;
