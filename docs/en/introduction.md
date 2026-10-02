# Introduction

nitra is a browser-only photo retoucher. This page covers what it is for, how it handles privacy, how edits are stored, and what it does not do.

## What nitra is

A phone applies its beauty processing while the shutter is open. nitra applies the same kind of processing afterwards, to any photo already on hand: one taken in the wrong mode, or one somebody else took.

Working after the fact removes the frame-rate budget. Passes can be as expensive as they need to be, and any value can be taken back.

## Privacy

The app is static files. A photo that is opened is decoded and rendered in the browser, and nothing is uploaded. There is no upload path and no account. Closing the tab discards the edit; what remains is the file that was exported.

The face-analysis models are served by the app itself rather than fetched from another host when the page loads. A request to a third party on load would reveal that the app is in use even if the photo never left the device. The models are pinned by URL and by digest, because a model that changes underneath the same URL changes what the app renders.

## Editing model

The source image is never modified. An edit is a JSON recipe, and the picture is rendered from it every time.

Every amount in a recipe is relative: radii are fractions of image size, coordinates are normalised, and type is sized against the frame. A recipe holding absolute pixels means something different when applied to a second photo, which would make batch application and preset sharing impossible later. It is also why a caption lands in the same place whether the export is four thousand pixels wide or one of nine tiles.

An export is never enlarged. A size taken from a destination is a ceiling, not a target: a photo that cannot reach it is written at the size it has, and the panel reports that size. Inventing pixels to satisfy a preset produces a file that claims a resolution it does not have.

The recipe carries no pixels and stays in the browser with the photo. There is no control for saving or loading one.

## Non-goals

- **No retouching that makes someone look like a different person.** Rebuilding bone structure, swapping faces, reshaping a body and filling anything in generatively are out of scope. So is replacing the background: a photograph that claims a place it was not taken in is over the same line. Putting a face back after an AI edit is the same line seen from the other side: the pixels it restores are ones the camera recorded (see [Restoring a face](restoring-a-face.md)).
- **No server.** There is no upload path, and none will be added.
- **No accounts.** An edit is kept nowhere but in the exported file.
- Video is out of scope for now. The pipeline is built so that it can be extended to video later.

The limits of reflection blur are described in [Blemishes and reflections](blemishes-and-reflections.md).
