# Grading

This page covers input formats, colour handling, the grade controls, effects, and the output transform that ends every render.

## Formats

JPEG, PNG, WebP, AVIF and HEIC open. HEIC is decoded in the browser through libheif, because only Safari reads it natively.

## Colour pipeline

Every image is converted into linear Display-P3, and every intermediate buffer is kept at 16 bits per channel. An iPhone records wide-gamut colour; converting to sRGB on the way in discards it.

## Tone

The grade has exposure, contrast, highlight and shadow recovery, end points, white balance, vibrance and saturation. A plot shows the tone response those controls produce.

## Saturation

Saturation scales Oklch chroma, with the gain attenuated inside the skin hue band. An HSV saturation multiplier rotates hue and drives skin into clipping ahead of everything else.

## Per-colour adjustment

Hue, saturation and lightness can be adjusted per colour across eight bands. The band centres are derived from the primaries rather than typed in. Near-neutral pixels are left alone, because a grey sky has a hue only in the arithmetic sense.

## Effects

Split toning, monochrome with channel weights, matte fade, vignette, glow, sharpening, clarity and film grain.

Sharpening works at the scale of the preview. On a larger export it is measured on a copy the size of the preview and brought up to the export's size, so the file is sharpened in the band the preview showed and finer detail, sensor noise included, is left as it was.

Clarity raises local contrast against an edge-preserving base, a guided filter, rather than against a blur. A blurred base lays a dark band along the dark side of every strong edge and a bright one along the other, which is the halo this control is known for. On a step of 3.6 stops at full strength, the guided base leaves about a third of that halo.

Film grain is band-limited noise: random values on a lattice half the grain size, joined by a cubic B-spline, with the variance held constant between lattice points. Grain drawn as square cells shows as a checkerboard once an export enlarges each cell to several pixels.

## Output transform

Every render ends in the same output transform, untouched photos included. A soft highlight rolloff sets scene white just under full scale rather than clipping it, and dithering is applied on the way down to eight bits.

Text is the one element composited after this transform (see [Framing and text](framing-and-text.md)).
