# Metadata

This page covers what an export does with the photo's metadata, and the modes that keep or write it.

## Removal

A portrait is often about to be posted somewhere, and the home address in its GPS tag should not go with it. Removal is the default, visible on the first screen rather than behind a settings panel, and asserted against the exported bytes in the test suite. It is also what an untouched edit does: a recipe that says nothing about metadata exports a file with none.

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

A canvas encoder happens not to carry EXIF across today, so an export comes out clean whether or not this step runs. The step runs anyway because that protection is incidental, and swapping the encoder would remove it without anything failing.

## Keep and Write

Sometimes the data is the point, so there are two other modes. **Keep** writes the photo's own values back. **Write** builds the block field by field: coordinates, capture time, camera and lens, exposure, artist and copyright. A location can be pasted as the pair a map puts on the clipboard instead of typed into two boxes.

In every mode, what goes into the file is exactly what the panel lists. The original block is read into those fields and then discarded rather than passed through, which keeps the embedded thumbnail out of the export and means a file never carries a tag that was not shown. Removal still runs first, so what is present was asked for.

## Encoding and formats

Text outside the Latin alphabet is written in both of the encodings readers expect. JPEG and PNG can be given a metadata block; WebP cannot in this build, and the panel says so rather than exporting without it.

An edit in **Write** mode carries its coordinates, so the exported file hands them over. The panel says that too.
