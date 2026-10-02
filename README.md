# nitra

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/nitra/ci.yml?branch=main&label=CI)](https://github.com/libraz/nitra/actions)
[![License](https://img.shields.io/badge/license-AGPL--3.0-green)](https://github.com/libraz/nitra/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)](https://react.dev/)
[![Platform](https://img.shields.io/badge/platform-browser%20%7C%20WebGL2-lightgrey)](https://nitra.libraz.net)
[![Demo](https://img.shields.io/badge/demo-nitra.libraz.net-2563eb)](https://nitra.libraz.net)

**nitra applies phone-camera retouching after the shot, to a photo you already have, without it leaving your device.** It runs entirely in the browser on WebGL2: there is no server, nothing is uploaded, and the face-analysis models are served by the app itself.

**[Open nitra](https://nitra.libraz.net)** · **[Documentation](https://github.com/libraz/nitra/blob/main/docs/en/introduction.md)** · **[Getting started](https://github.com/libraz/nitra/blob/main/docs/en/getting-started.md)**

> **Status** — pre-1.0. The recipe format is versioned; the rest of the interface may still change.

## What it does

- **Opens and grades** — JPEG, PNG, WebP, AVIF and HEIC, worked on in linear Display-P3 at 16 bits per channel; exposure, contrast, highlights and shadows, white balance, saturation as Oklch chroma, per-colour hue/saturation/lightness and finishing effects. [Grading](https://github.com/libraz/nitra/blob/main/docs/en/grading.md)
- **Retouches the person** — skin, eyes, lips, teeth, cheeks, hair, the background behind them, one added light, and the shape of the face within a bound it measures and shows. [Retouching a person](https://github.com/libraz/nitra/blob/main/docs/en/retouching-a-person.md)
- **Removes blemishes and reflections** — fills a blemish from the skin around it, and blurs a bystander caught in a catchlight, mirror or glass inside a circle you place. [Blemishes and reflections](https://github.com/libraz/nitra/blob/main/docs/en/blemishes-and-reflections.md)
- **Puts a face back after an AI edit** — restores the photographed face from the original into a picture a generative edit redrew. [Restoring a face](https://github.com/libraz/nitra/blob/main/docs/en/restoring-a-face.md)
- **Frames and captions** — flips, turns, straightening, crops sized for Instagram, X, Facebook, YouTube and TikTok, and text in any typeface on your machine. [Framing and text](https://github.com/libraz/nitra/blob/main/docs/en/framing-and-text.md)
- **Splits across a grid** — cuts one picture into profile-grid tiles named in the order they must be uploaded. [Grid split](https://github.com/libraz/nitra/blob/main/docs/en/grid-split.md)
- **Controls metadata** — removes it on every export by default, or keeps or writes it field by field; the file carries exactly what the panel lists. [Metadata](https://github.com/libraz/nitra/blob/main/docs/en/metadata.md)
- **Shows its work** — a starting grade suggested from the photo, finishes as thumbnails of your own picture, measurements of texture kept and how far the face moved, magnification to one screen pixel per file pixel, Simple and Detail modes, English and Japanese, light and dark. [Interface](https://github.com/libraz/nitra/blob/main/docs/en/interface.md)

Edits are non-destructive: the source is never modified, every amount is relative to the image, and an export is never enlarged. The edit lives only in the tab; what you keep is the exported file.

## Getting started

Nothing needs installing to use it: [nitra.libraz.net](https://nitra.libraz.net) serves the same build this repository produces. Open a photo, adjust it, export.

To run it locally or work on it:

```bash
bun install
bun run dev        # http://localhost:5173
```

The first run downloads the face-analysis models into `public/models` (about forty megabytes, pinned by digest, not committed). Without them the app still runs and the face controls say the analysis is unavailable. A browser with WebGL2 and half-float render targets is required: current Chrome, Edge, Safari or Firefox.

```bash
bun run check      # lint and format
bun run typecheck
bun run test
bun run build      # static files in dist/, ready for any static host
```

## Documentation

- **Learn** — [Introduction](https://github.com/libraz/nitra/blob/main/docs/en/introduction.md) · [Getting started](https://github.com/libraz/nitra/blob/main/docs/en/getting-started.md) · [Interface](https://github.com/libraz/nitra/blob/main/docs/en/interface.md)
- **Guides** — [Grading](https://github.com/libraz/nitra/blob/main/docs/en/grading.md) · [Retouching a person](https://github.com/libraz/nitra/blob/main/docs/en/retouching-a-person.md) · [Blemishes and reflections](https://github.com/libraz/nitra/blob/main/docs/en/blemishes-and-reflections.md) · [Restoring a face](https://github.com/libraz/nitra/blob/main/docs/en/restoring-a-face.md) · [Framing and text](https://github.com/libraz/nitra/blob/main/docs/en/framing-and-text.md) · [Grid split](https://github.com/libraz/nitra/blob/main/docs/en/grid-split.md) · [Metadata](https://github.com/libraz/nitra/blob/main/docs/en/metadata.md)

## Non-goals

nitra retouches; it does not make someone look like a different person. Rebuilding bone structure, swapping faces, reshaping a body, filling in generatively and replacing the background are out of scope. Blurring a reflection is not erasure, and nitra makes no claim about what could be recovered from the file. There is no server, no upload path and no accounts, and none will be added. Video is out of scope for now. See [Introduction](https://github.com/libraz/nitra/blob/main/docs/en/introduction.md#non-goals) for the reasons.

## License

[AGPL-3.0](LICENSE)
