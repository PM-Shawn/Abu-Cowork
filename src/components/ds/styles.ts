// Shared class fragments for src/components/ds. Complete literals so Tailwind generates them.
export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-focus';
export const DISABLED = 'disabled:pointer-events-none disabled:opacity-40';
export const FIELD_BOX = 'w-full rounded-control border border-control-border bg-field px-2 text-ui text-label placeholder:text-label-placeholder aria-[invalid=true]:border-danger';
export const FLOAT_SURFACE = 'rounded-panel bg-raised text-label shadow-float';
export const MENU_ITEM = 'flex h-6 cursor-default select-none items-center gap-2 rounded-control px-2 text-ui text-label outline-none data-[highlighted]:bg-fill-selected';
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
export const SCRIM_MOTION ='data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-base data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-fast';
// Floating layers keep this many pixels between themselves and the window edge.
export const EDGE_GAP = 8;
export const DIALOG_SURFACE = 'fixed z-dialog flex flex-col rounded-window bg-raised text-label shadow-dialog outline-none';
// Centered. At most the window height minus 48px above and below; the macOS title band is 44px.
export const DIALOG_BOX = `${DIALOG_SURFACE} left-1/2 top-1/2 max-h-[calc(100dvh-6rem)] w-full -translate-x-1/2 -translate-y-1/2 p-6`;
// The settings window. Auto margins center it, so a fixed element inside it still covers the app window.
export const DIALOG_PAGE = `${DIALOG_SURFACE} inset-x-0 bottom-6 m-auto max-h-[840px] w-[min(1180px,92vw)] overflow-hidden`;
