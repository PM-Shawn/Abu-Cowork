// Shared class fragments for src/components/ds, with the constants and the one test that go with
// them. Complete literals so Tailwind generates them.
export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-focus';
export const DISABLED = 'disabled:pointer-events-none disabled:opacity-40';
// The look of DISABLED on a control that is working (aria-disabled): it keeps the focus. It still
// takes the pointer, so a press lands on it and not on what is behind it (a card that opens, a
// window's own box); the control swallows that press (button.tsx, switch.tsx). The fills that
// answer the pointer are written `not-aria-disabled:hover:` / `not-aria-disabled:active:`, so a
// working control keeps its resting look.
export const BUSY = 'aria-disabled:opacity-40 aria-disabled:cursor-default';
// Whether a control carries that mark: one that is working opens no menu and starts nothing.
export const isWorking = (element: Element) => element.getAttribute('aria-disabled') === 'true';
export const FIELD_BOX = 'w-full rounded-control border border-control-border bg-field px-2 text-ui text-label placeholder:text-label-placeholder aria-[invalid=true]:border-danger';
export const FLOAT_SURFACE = 'rounded-panel bg-raised text-label shadow-float';
export const MENU_ITEM = 'flex h-6 cursor-default select-none items-center gap-2 rounded-control px-2 text-ui text-label outline-none data-[highlighted]:bg-fill-selected';
// The two fills of a segmented control: its track, and the selected segment painted over the
// track. scripts/designTokens.test.ts reads both and holds the segment apart from its track.
export const SEGMENT_TRACK = 'bg-fill';
export const SEGMENT_SELECTED = 'data-[state=on]:bg-fill-selected';
// Radix sets data-disabled only on disabled items.
export const RADIX_ITEM_DISABLED = 'data-[disabled]:opacity-40';
export const FLOAT_MOTION = 'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97 data-[state=open]:duration-fast data-[state=open]:ease-enter data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-97 data-[state=closed]:duration-fast data-[state=closed]:ease-exit';
// Tooltips report delayed-open / instant-open instead of open.
export const TOOLTIP_MOTION = 'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-97 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0 data-[state=instant-open]:zoom-in-97 duration-fast ease-enter data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-97 data-[state=closed]:ease-exit';
export const DIALOG_MOTION = 'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-98 data-[state=open]:duration-base data-[state=open]:ease-enter data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 data-[state=closed]:duration-fast data-[state=closed]:ease-exit';
// A dialog stays on the page while it fades out. Its buttons take no click then: a second click
// on Save must not land. Important, because Radix sets pointer-events inline on a modal layer.
// Keys can still reach a closing dialog, so a save handler also checks that its dialog is open.
export const DIALOG_CLOSING = 'data-[state=closed]:pointer-events-none!';
export const SCRIM_MOTION = 'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-base data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-fast';
// Floating layers keep this many pixels between themselves and the window edge.
export const EDGE_GAP = 8;
export const DIALOG_SURFACE = 'fixed z-dialog flex flex-col rounded-window bg-raised text-label shadow-dialog outline-none';
// Centered. At most the window height minus 48px above and below; the macOS title band is 44px.
export const DIALOG_BOX = `${DIALOG_SURFACE} left-1/2 top-1/2 max-h-[calc(100dvh-6rem)] w-full -translate-x-1/2 -translate-y-1/2 p-6`;
// The settings window. Auto margins center it, so a fixed element inside it still covers the app window.
export const DIALOG_PAGE = `${DIALOG_SURFACE} inset-x-0 bottom-6 m-auto max-h-[840px] w-[min(1180px,92vw)] overflow-hidden`;
// A viewer: the whole window up to a 24px margin, with no padding of its own.
export const DIALOG_VIEWER = `${DIALOG_SURFACE} inset-6 p-0`;
// The longest fade of a design-system layer: `duration-base` in src/styles/tokens.css.
export const LAYER_FADE_MS = 200;
// How long a notification that has just appeared or moved takes no pointer press: its entrance
// (`duration-base`, 200 ms) plus 300 ms, about the time a person needs to see that the target has
// changed and hold back a press that is already on its way. A press that started before the move
// lands inside this window and is dropped; one made after it was aimed at what is there.
export const TOAST_SETTLE_MS = LAYER_FADE_MS + 300;
// A box that settles (an approval, a question, a window's question about unsaved input, a
// `Dialog settles` window, a `Settling` part of the page) holds pointer presses back for the
// same interval after it appears (`data-ds-settling` on the box, see settle.ts). While
// the box carries the mark, nothing inside it is the target of the pointer: a press lands on the
// box itself, so no control in it hears the press begin. Important, like DIALOG_CLOSING.
export const SETTLING_BOX = 'data-ds-settling:**:pointer-events-none!';
