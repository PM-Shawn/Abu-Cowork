export const IMAGE_ZOOM_MIN = 0.25;
export const IMAGE_ZOOM_MAX = 4;

export function clampImageZoom(value: number): number {
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, value));
}

export function nextImageRotation(current: number, direction: -1 | 1): number {
  return (current + direction * 90 + 360) % 360;
}
