# Retouching a person

This page covers the face and person controls: how the analysis runs, what each control group does, and the bound on reshaping.

## Analysis

The face analysis runs on the device. Its models are served by the app itself rather than fetched from another host when the page loads: the photo never leaves the device, and a request to a third party on load would still tell that party the app is in use. They are pinned by URL and by digest, because a model that changes underneath the same URL changes what the app renders.

None of the controls work without a face. The panel reports which of three things happened: a face was found, there is no face in the photo, or the analysis could not run. A photograph of a landscape leaves the skin controls off instead of live and inert.

## Controls

- **Skin.** Smoothing takes off fine texture and pushes down the slow unevenness that reads as blotchy, and a trim decides how much texture survives: the negative side is how plastic skin happens, the positive side is the repair for having gone too far without undoing the rest. Also shine on the forehead and nose, colour evened towards its own local average, and the shadow under the eyes lifted.
- **Eyes, lips and cheeks.** The white of the eye is brightened without touching the iris, and the iris gains definition as local contrast, so a pale eye stays pale. The catchlight is the one the photograph already has, lifted rather than painted in: where a drawn highlight belongs is decided by a light that cannot be seen from the file, and in the wrong place it reads as a glass eye. Then yellow off the teeth, and colour on the lips and cheeks.
- **Hair.** Sheen, grey strands taken back towards the colour around them, and a tint. It is keyed to the segmentation rather than to the landmarks, so it still holds on a head turned away from the camera. A strand that is only lighter than its surroundings is a highlight, and taking the colour out of a highlight is how hair comes out wet, so lightness alone is not enough to act on.
- **Background.** The background goes out of focus while the person stays sharp, and the aperture is a choice (round, bladed or anamorphic) because the shape an out-of-focus highlight comes out as is what says a lens was involved. Highlights are lifted before the convolution: a real one is bright because the sensor saturated there, and convolving the recorded value spreads a dull grey disc. The background can also be darkened or desaturated to lift the person off it.
- **Light.** One light, placed on the picture like a clock face, with how far round it stands towards the camera, how broad the source is, and its colour. It only ever adds. The lighting already in the photograph cannot be removed without separating reflectance from shading, so a light that is only added cannot contradict it. It is added as a gain rather than a sum, which keeps the skin's texture instead of blowing out the dark half of a face.
- **Shape.** Eight amounts: the outline, the jaw, the chin, the opening and tilt of the eyes, the width and bridge of the nose, and the width of the mouth.

## Bound on reshaping

nitra retouches; it does not turn somebody into a different person. The outline, the body and a face swap are one mechanism, so where that line falls is a product decision rather than a technical limit, and it is easier to hold from the start than to draw back later.

The reshaping is therefore bounded and reports what it did. Every amount is a fraction of the face's own width, each displacement is clamped, and the reach of a control stops short of the frame, which keeps a doorway behind the face from bending. How far the face actually moved is measured and shown next to the other numbers, in the same units. The reading passes its warning while a single slider is still at the top of its own track, rather than only once several are stacked.

See [Interface](interface.md) for the other measurements, and [Restoring a face](restoring-a-face.md) for putting a photographed face back into an edited picture.
