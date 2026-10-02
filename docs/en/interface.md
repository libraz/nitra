# Interface

This page covers suggestions, measurements, magnification, the two editor modes, languages, and appearance.

## Suggestions and finishes

A starting grade is suggested from the image itself. Finishes are offered as thumbnails of the photo being edited rather than as names.

## Measurements

The result is measured and the numbers are shown: skin texture kept, how far the face was moved, clipped highlights, blocked shadows and clipped chroma. Nothing is forbidden.

## Magnifying

The picture can be magnified to judge it, by scroll, pinch or the bar along the foot, and moved by dragging. The canvas is given more pixels rather than the fitted picture being stretched. At a hundred per cent one pixel of the exported file covers one pixel of the screen, so what is soft on screen is soft in the file.

## Simple and Detail modes

The editor is offered in two modes. Simple mode shows no numbers at all, which leaves showing the result as the only way to offer a choice. Detail mode opens every parameter and can list only the ones that have been changed.

## Languages

The interface ships in English and Japanese and picks one from the browser. Adding a language is one file under `src/i18n/locales/` and one entry in the locale map. The catalogue is typed against English, so an untranslated message fails to compile.

## Light and dark

Light and dark are both available, and "match system" is a third option rather than a default that is overwritten on the first click, since an editor is opened in daylight and again at night.

The area immediately around the photo stays a neutral mid grey in either. Colour is judged against what is next to it, and a white surround makes every photo look darker and warmer than it is; only the chrome further out lightens.
