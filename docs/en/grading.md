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

## Output transform

Every render ends in the same output transform, untouched photos included. A soft highlight rolloff sets scene white just under full scale rather than clipping it, and dithering is applied on the way down to eight bits.

Text is the one element composited after this transform (see [Framing and text](framing-and-text.md)).
