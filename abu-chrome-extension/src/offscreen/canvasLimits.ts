/**
 * Chrome's canvas ceilings, and the refusal to send when a stitch would cross
 * one.
 *
 * Both bounds fail SILENTLY. A canvas past either one keeps reporting the
 * width and height it was assigned, still hands out a 2d context, and still
 * accepts `drawImage` without throwing — but it holds no pixels, and
 * `toDataURL()` returns the string `"data:,"` instead of a PNG. Nothing in
 * that sequence looks like an error, which is how a too-tall page used to come
 * back from `screenshot_full_page` as a successful capture carrying six
 * characters of garbage where the image should be.
 *
 * Measured in Chrome 152 at the boundary in both directions rather than taken
 * from documentation: 100x65535 encodes and 100x65536 does not; 8192x32768
 * (exactly 16384², the area ceiling) encodes and 8192x32800 does not.
 */

/** Largest width or height Chrome will keep pixels for. */
export const MAX_CANVAS_SIDE = 65535;

/** Largest total pixel count, independent of the individual sides. */
export const MAX_CANVAS_AREA = 16384 * 16384;

/**
 * `null` when a canvas of this size encodes, otherwise the sentence to fail
 * with. The message names the size asked for, the bound it broke, and the way
 * forward — a model that is only told "capture failed" retries the same
 * capture and waits out the same scroll again.
 */
export function canvasLimitRefusal(width: number, height: number): string | null {
  if (height > MAX_CANVAS_SIDE) {
    return `Page is too tall to capture as one image: the stitched canvas would be ${height} pixels `
      + `high and the browser stops keeping pixels past ${MAX_CANVAS_SIDE}. Use screenshot for the `
      + 'visible area, or scroll and capture the part you need.';
  }
  if (width > MAX_CANVAS_SIDE) {
    return `Page is too wide to capture as one image: the stitched canvas would be ${width} pixels `
      + `wide and the browser stops keeping pixels past ${MAX_CANVAS_SIDE}. Use screenshot for the `
      + 'visible area instead.';
  }
  if (width * height > MAX_CANVAS_AREA) {
    return `Page is too large to capture as one image: the stitched canvas would be ${width}x${height} `
      + `(${width * height} pixels) and the browser stops keeping pixels past ${MAX_CANVAS_AREA}. Use `
      + 'screenshot for the visible area, or capture the page in sections.';
  }
  return null;
}
