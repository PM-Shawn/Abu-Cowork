// Shared class fragments for src/components/ds. Complete literals so Tailwind generates them.
export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-focus';
export const DISABLED = 'disabled:pointer-events-none disabled:opacity-40';
export const FIELD_BOX = 'w-full rounded-control border border-control-border bg-field px-2 text-ui text-label placeholder:text-label-placeholder aria-[invalid=true]:border-danger';
export const FLOAT_SURFACE = 'rounded-panel bg-material text-label shadow-float backdrop-blur-xl';
export const MENU_ITEM = 'flex h-6 cursor-default select-none items-center gap-2 rounded-control px-2 text-ui text-label outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-fill-selected';
export const FLOAT_MOTION = 'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97 data-[state=open]:duration-fast data-[state=open]:ease-enter data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-97 data-[state=closed]:duration-fast data-[state=closed]:ease-exit';
// Tooltips report delayed-open / instant-open instead of open.
export const TOOLTIP_MOTION = 'animate-in fade-in-0 zoom-in-97 duration-fast ease-enter data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-97 data-[state=closed]:ease-exit';
export const DIALOG_MOTION = 'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-98 data-[state=open]:duration-base data-[state=open]:ease-enter data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 data-[state=closed]:duration-fast data-[state=closed]:ease-exit';
export const SCRIM_MOTION = 'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-base data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-fast';
export const DIALOG_BOX = 'fixed left-1/2 top-1/2 z-dialog w-full -translate-x-1/2 -translate-y-1/2 rounded-window bg-raised p-6 text-label shadow-dialog outline-none';
