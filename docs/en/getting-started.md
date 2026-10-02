# Getting started

This page covers using the hosted demo and running nitra locally.

## Using the demo

[nitra.libraz.net](https://nitra.libraz.net) is the whole app, not a cut-down version, and it keeps the same privacy model: the page is static files and a photo that is opened is decoded and rendered in the browser. Nothing needs installing.

Open a photo in a supported format (see [Grading](grading.md)). The editor has two modes. Simple mode shows no numbers and offers choices as pictures of the result; Detail mode opens every parameter (see [Interface](interface.md)). Exporting writes a new file; the opened photo is not modified, and the edit exists only for as long as the tab is open.

## Running locally

The demo serves the same build this repository produces. To run or work on it locally:

```bash
bun install
bun run dev
```

`bun run dev` serves the app at `http://localhost:5173`. The first run downloads the face-analysis models and the runtime that drives them into `public/models`. The download is around forty megabytes, pinned by digest, and not committed. Without the models the app still runs; the face controls report that the analysis is unavailable.

## Browser requirements

A browser with WebGL2 and half-float render targets is required: current Chrome, Edge, Safari or Firefox.

## Commands

```bash
bun run check      # lint and format
bun run typecheck
bun run test
bun run build      # static files in dist/, ready for any static host
```
