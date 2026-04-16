export type TimerId = number | string;

export interface ClockAdapter {
  now(): number;
  setTimeout(cb: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  setInterval(cb: () => void, ms: number): TimerId;
  clearInterval(id: TimerId): void;
}
