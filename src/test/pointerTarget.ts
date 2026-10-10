// Where a pointer press aimed at `element` lands. Unit tests load no stylesheet, so a class that
// takes the pointer off an element (`pointer-events: none`) has no effect on user-event: the press
// would reach an element that the browser passes over. This reads the two classes the design
// system uses for that and gives the element the browser would hit: the nearest ancestor that
// still takes the pointer.
const takesNoPointer = (element: HTMLElement) =>
  (element.matches(':disabled') && element.classList.contains('disabled:pointer-events-none'))
  || (element.getAttribute('aria-disabled') === 'true' && element.classList.contains('aria-disabled:pointer-events-none'));

export function pointerTargetOf(element: HTMLElement): HTMLElement {
  let target: HTMLElement | null = element;
  while (target && takesNoPointer(target)) target = target.parentElement;
  if (!target) throw new Error('No element under the pointer takes a press');
  return target;
}
