// What the user used last: the pointer or the keyboard. A layer that moves focus by code reads
// this to say whether the focus ring belongs there. The browser guesses on its own, and for the
// first focus moved by code after a load it guesses "keyboard" even after a pointer press on a
// control that takes no focus (a menu trigger).
let pointer = false;

export function lastInputWasPointer(): boolean {
  return pointer;
}

// Listens on the document; returns the function that stops listening.
export function trackInputModality(): () => void {
  const onPointer = () => { pointer = true; };
  const onKey = () => { pointer = false; };
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  return () => {
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
  };
}
