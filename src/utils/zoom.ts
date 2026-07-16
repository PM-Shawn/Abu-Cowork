/** Zoom bounds/steps — mirror the 25%–300% range used by comparable preview panels. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.25;      // button step
export const ZOOM_WHEEL_STEP = 0.1; // Cmd/Ctrl+wheel step

const round2 = (n: number) => Math.round(n * 100) / 100;

export function clampZoom(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}
export function zoomIn(scale: number): number {
  return clampZoom(round2(scale + ZOOM_STEP));
}
export function zoomOut(scale: number): number {
  return clampZoom(round2(scale - ZOOM_STEP));
}
/** deltaY < 0 (wheel up) zooms in; > 0 zooms out. */
export function zoomByWheel(scale: number, deltaY: number): number {
  const next = deltaY < 0 ? scale + ZOOM_WHEEL_STEP : scale - ZOOM_WHEEL_STEP;
  return clampZoom(round2(next));
}
export function formatZoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
