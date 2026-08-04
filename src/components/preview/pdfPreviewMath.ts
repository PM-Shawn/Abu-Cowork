export const PDF_SCALE_MIN = 0.5;
export const PDF_SCALE_MAX = 4;

export function clampPdfScale(value: number): number {
  return Math.min(PDF_SCALE_MAX, Math.max(PDF_SCALE_MIN, value));
}

export function nextPdfRotation(current: number): number {
  return (current + 90) % 360;
}
