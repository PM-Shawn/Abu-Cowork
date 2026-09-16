/**
 * The refusal to send when a page reports no area to capture.
 *
 * `captureFullPage` derives its slice count from the page's own measurements:
 * `Math.ceil(scrollHeight / viewportHeight)`. A page that measures zero — a
 * hidden container, `display:none`, some PDF and embedded views — yields zero
 * slices, the capture loop never runs, and the empty list reaches the stitcher,
 * where `images[0].naturalWidth` threw `Cannot read properties of undefined`.
 *
 * That sentence names neither what happened nor what to do, so the model's
 * next move is to retry the identical capture. Same reasoning as
 * `canvasLimitRefusal` next door, and the same wording policy: say the size
 * that was measured, say why it cannot be captured, and name the way forward.
 */
export function noCaptureAreaRefusal(scrollHeight: number, viewportHeight: number): string | null {
  const measured = (value: number): boolean => Number.isFinite(value) && value > 0;
  if (measured(scrollHeight) && measured(viewportHeight)) return null;
  return `Page reports no area to capture (content ${describe(scrollHeight)} by viewport `
    + `${describe(viewportHeight)}). A hidden, zero-height or embedded document has nothing to `
    + 'stitch. Bring the content into view, or use screenshot for the visible area.';
}

function describe(value: number): string {
  return Number.isFinite(value) ? `${value}px` : String(value);
}
