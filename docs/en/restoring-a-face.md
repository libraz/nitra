# Restoring a face

This page covers putting the photographed face back into a picture that an AI edit has redrawn.

## What it does

A generative edit (a new background, a different outfit, a caption burnt in) redraws the whole frame, and the face comes back as somebody who looks a little like the original. The edited picture is opened as usual, then the original photo is opened in this panel. nitra finds the face in both, lines the original up with the edited picture, and puts the photographed face back.

## Alignment

Nothing is placed by hand and nothing is invented. Both images are the same photograph, so the alignment is a fit between the same 468 landmarks on each face. It is limited to moving, turning and scaling: stretching the original onto the generated face's proportions would hand back the very face it is meant to replace.

When the edit also changed the pose or the expression, the fit cannot absorb it. The panel reports how far off the fit is rather than refusing.

## The join

The join sits a band inside the skin, never on the outline, so it crosses cheek rather than the hairline, the jaw and the ears. The light is matched as a gain in the frame's own colour space. The face goes in before the grade and the grain, so both run over the join.

## Limits

- Only the face comes back, not the hair, the body or the clothes. That boundary needs matting at the hairline, which nitra does not do.
- Every face that is paired is restored together. In a group photo where one face survived the edit, all of them are put back.
- The original is pixels, so like a loaded font it does not survive a reload. Opening it again restores the panel to where it was.
