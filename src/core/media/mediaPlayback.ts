let playing: HTMLMediaElement | undefined;

export function claimMediaPlayback(element: HTMLMediaElement): void {
  if (playing && playing !== element) playing.pause();
  playing = element;
}

export function releaseMediaPlayback(element: HTMLMediaElement): void {
  element.pause();
  if (playing === element) playing = undefined;
}
