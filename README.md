# nitra

Phone-camera retouching, applied after the shot. Photos never leave the device.

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/nitra/ci.yml?branch=main&label=CI)](https://github.com/libraz/nitra/actions)
[![License](https://img.shields.io/badge/license-AGPL--3.0%20%2F%20Commercial-green)](https://github.com/libraz/nitra/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)](https://react.dev/)

A phone applies its beauty processing while the shutter is open. nitra applies the same kind of processing afterwards, to any photo you already have — the one taken in the wrong mode, or the one somebody else took of you.

Working after the fact removes the frame-rate budget. Passes can be as expensive as they need to be, and any value can be taken back.

## What it does today

- Opens JPEG, PNG, WebP, AVIF and HEIC. HEIC is decoded in the browser through libheif, because only Safari reads it natively.
- Converts everything into linear Display-P3 and keeps every intermediate buffer at 16 bits per channel. An iPhone records wide-gamut colour; converting to sRGB on the way in throws it away.
- Grades: exposure, contrast, highlight and shadow recovery, end points, white balance, vibrance and saturation, and a tone curve.
- Scales saturation as Oklch chroma, with the gain attenuated inside the skin hue band. An HSV saturation multiplier rotates hue and drives skin into clipping ahead of everything else.
- Adjusts hue, saturation and lightness per colour, across eight bands whose centres are derived from the primaries rather than typed in. Near-neutral pixels are left alone, because a grey sky has a hue only in the arithmetic sense.
- Effects: split toning, monochrome with channel weights, matte fade, vignette, glow, sharpening, clarity, film grain, highlight rolloff, and dithering on the way down to eight bits.
- Fills a blemish where you click it. Skin from around the mark is copied in rather than smoothed over, so the pores come with it.
- Blurs a bystander caught in a reflection — a corneal catchlight, a mirror, metal or glass — inside a circle you place. It is a blur filter run in a selection: the average reads the photograph around the circle so the edge does not show, and nothing outside the ring changes. The strength is a fraction of each circle's own radius, so one setting suits an eye and a mirror at once. One click on a detected iris places the circle at its width.
- Retouches the person: skin, eyes, lips, teeth, cheeks, hair, the background behind them, one added light, and the shape of the face within a bound it reports (see below).
- Frames: flips, quarter turns, straightening, and a crop that can be locked to a shape. Straightening trims the frame to keep it filled, so no corner comes out empty.
- Crops to what a destination actually publishes — Instagram, X, Facebook, YouTube, TikTok — taking the shape and the size as one decision.
- Adds text. Type is rasterised by the browser, so Japanese composes correctly, and it is composited after the output transform because a caption is not light that was in the room.
- Sets that text in any typeface on the machine: load a font file and it joins the picker, sampled in itself. A face that has no glyph for a character in the caption says so, rather than letting the substitution be discovered in the exported file.
- Splits one picture across a grid of posts, in the order they have to be uploaded (see below).
- Suggests a starting grade from the image itself, and offers finishes as thumbnails of your own photo rather than as names.
- Measures the result — skin texture kept, how far the face was moved, clipped highlights, blocked shadows, clipped chroma — and shows the numbers. Nothing is forbidden.
- Removes the metadata, keeps it, or writes it field by field — location, capture time, camera, credit (see below).
- Offers the editor twice. Simple mode shows no numbers at all, which is what leaves showing the result as the only way to offer a choice; detail mode opens every parameter, and can list only the ones that have been changed.
- Runs in light or dark, in English or Japanese.

## Retouching a person

The face analysis runs here. Its models are served by the app itself rather than fetched from somebody else's host when the page loads: the photo never leaves the device, and a request to a third party on load would still tell that third party the app is in use. They are pinned by URL and by digest, because a model that changes underneath the same URL changes what the app renders.

None of it works without a face, and the panel says which of three things happened — a face was found, there is no face in this photo, or the analysis could not run. A photograph of a landscape leaves the skin controls off instead of live and inert.

- **Skin.** Smoothing takes off fine texture and pushes down the slow unevenness that reads as blotchy, and a trim decides how much texture survives: the negative side is how plastic skin happens, the positive side is the repair for having gone too far without undoing the rest. Also shine on the forehead and nose, colour evened towards its own local average, and the shadow under the eyes lifted.
- **Eyes, lips and cheeks.** The white of the eye is brightened without touching the iris, and the iris gains definition as local contrast, so a pale eye stays pale. The catchlight is the one the photograph already has, lifted rather than painted in — where a drawn highlight belongs is decided by a light nobody can see from the file, and in the wrong place it reads as a glass eye. Then yellow off the teeth, and colour on the lips and cheeks.
- **Hair.** Sheen, grey strands taken back towards the colour around them, and a tint. It is keyed to the segmentation rather than to the landmarks, so it still holds on a head turned away from the camera. A strand that is only lighter than its surroundings is a highlight, and taking the colour out of a highlight is how hair comes out wet, so lightness alone is not enough to act on.
- **Background.** The background goes out of focus while the person stays sharp, and the aperture is a choice — round, bladed or anamorphic — because the shape an out-of-focus highlight comes out as is what says a lens was involved. Highlights are lifted before the convolution: a real one is bright because the sensor saturated there, and convolving the recorded value spreads a dull grey disc. The background can also be darkened or desaturated to lift the person off it.
- **Light.** One light, placed on the picture like a clock face, with how far round it stands towards the camera, how broad the source is, and its colour. It only ever adds. The lighting already in the photograph cannot be removed without separating reflectance from shading, so a light that is only added cannot contradict it — and it is added as a gain rather than a sum, which is what keeps the skin's texture instead of blowing out the dark half of a face.
- **Shape.** Eight amounts: the outline, the jaw, the chin, the opening and tilt of the eyes, the width and bridge of the nose, and the width of the mouth.

nitra retouches; it does not turn somebody into a different person. The outline, the body and a face swap are one mechanism, so where that line falls is a product decision rather than a technical limit, and it is easier to hold now than to draw back later.

So the reshaping is bounded and says what it did. Every amount is a fraction of the face's own width, each displacement is clamped, and the reach of a control stops short of the frame, which is what keeps a doorway behind the face from bending. How far the face actually moved is measured and shown next to the other numbers, in the same units, and the reading passes its warning while a single slider is still at the top of its own track, rather than only once several are stacked.

## Splitting a picture across a grid

A profile grid fills newest first: the post made last sits at the top left. So a picture cut into nine tiles has to be uploaded starting from the bottom right, and getting that backwards is only discovered once the posts are public.

nitra computes the order and writes it into the front of every file name, so the tiles are uploaded by counting rather than by reasoning. All of them arrive as one archive.

The cut happens after the render, not before it: each tile is a slice of one finished picture, so the grain, the vignette and the tone match across every seam. Rendering the tiles separately would centre each tile's vignette on the tile.

## Metadata

A portrait is about to be posted somewhere, and the home address in its GPS tag should not go with it. Removal is the default, visible on the first screen rather than behind a settings panel, and asserted against the exported bytes in the test suite. It is also what an untouched edit does: a recipe that says nothing about metadata exports a file with none.

| Field | Handling |
| --- | --- |
| GPS coordinates, altitude, bearing | Removed |
| Capture and digitisation timestamps | Removed |
| Camera and lens model | Removed |
| Body serial number | Removed |
| Embedded thumbnail | Removed |
| Author and copyright fields | Removed |
| ICC colour profile | **Kept** — without it the file is displayed against the wrong primaries |
| Orientation | Applied to the pixels, then discarded |

A canvas encoder happens not to carry EXIF across today, so an export comes out clean whether or not this step runs. That is why it runs anyway: the protection is incidental, and swapping the encoder would remove it without anything failing.

Sometimes the data is the point, so there are two other answers. **Keep** writes the photo's own values back. **Write** builds the block field by field — coordinates, capture time, camera and lens, exposure, artist and copyright — and a location can be pasted as the pair a map puts on the clipboard instead of typed into two boxes.

In every case, what goes into the file is exactly what the panel lists. The original block is read into those fields and then discarded rather than passed through, which is what keeps the embedded thumbnail out of the export and means a file never carries a tag nobody was shown. Removal still runs first, so what is there was asked for.

Text outside the Latin alphabet is written in both of the encodings readers expect. JPEG and PNG can be given a metadata block; WebP cannot in this build, and the panel says so rather than exporting without it. An edit in **Write** mode carries its coordinates, so a recipe shared in that state hands them over — the panel says that too.

## Editing is non-destructive

The source image is never modified. An edit is a JSON recipe, and the picture is rendered from it every time.

Every amount in a recipe is relative — radii as fractions of image size, coordinates normalised, type sized against the frame. A recipe holding absolute pixels means something different the moment it is applied to a second photo, which is what makes batch application and preset sharing possible later rather than impossible. It is also why a caption lands in the same place whether the export is four thousand pixels wide or one of nine tiles.

An export is never enlarged. A size taken from a destination is a ceiling, not a target: a photo that cannot reach it is written at the size it has, and the panel says so. Inventing pixels to satisfy a preset produces a file that claims a resolution it does not have.

The recipe carries no pixels, so it can be shared while the photo stays on the device.

## Running it

```bash
bun install
bun run dev
```

The first run downloads the face-analysis models and the runtime that drives them into `public/models` — around forty megabytes, pinned by digest, and not committed. Without them the app still runs; the face controls report that the analysis is unavailable.

Requires a browser with WebGL2 and half-float render targets: current Chrome, Edge, Safari or Firefox.

```bash
bun run check      # lint and format
bun run typecheck
bun run test
bun run build
```

## Languages

The interface ships in English and Japanese and picks one from the browser. Adding a language is one file under `src/i18n/locales/` and one entry in the locale map; the catalogue is typed against English, so an untranslated message fails to compile.

## Light and dark

Both, and "match system" as a third option rather than a default that gets overwritten on the first click — an editor gets opened in daylight and again at night.

The area immediately around the photo stays a neutral mid grey in either. Colour is judged against what is next to it, and a white surround makes every photo look darker and warmer than it is; only the chrome further out lightens.

## Non-goals

- **No retouching that makes someone look like a different person.** Rebuilding bone structure, swapping faces, reshaping a body and filling anything in generatively are out of scope. So is replacing the background: a photograph that claims a place it was not taken in is over the same line.
- **Blurring a reflection is not erasure, and nitra makes no claim about what could be recovered from the file.** How much detail is left is what the slider says and nothing more; this is not the ISO/IEC 27038 sense of removal. Judge the result by looking at it.
- **At the top of that slider an eye loses its catchlight.** A reach wider than the circle flattens it to close to one tone, and nothing is drawn back in to replace it.
- **No server.** There is no upload path, and none will be added.
- **No accounts.** Saving and sharing happen through files.
- Video is out of scope for now. The pipeline is built so it can be extended to video later.

## Status

Pre-1.0. The recipe format is versioned and migrated on load, but the rest of the surface may change.

## License

AGPL-3.0, with a commercial license available. See [LICENSE](LICENSE).
