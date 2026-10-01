import { cva } from 'class-variance-authority';
import { DISABLED, FOCUS_RING } from './styles';

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'danger';
export type ControlSize = 'sm' | 'md';

// primary is the one filled button of an area (the inverse of the text color).
export const buttonVariants = cva(
  `inline-flex shrink-0 select-none items-center justify-center gap-1 rounded-control font-medium transition-colors duration-fast ${FOCUS_RING} ${DISABLED}`,
  {
    variants: {
      variant: {
        primary: 'bg-emphasis text-on-emphasis hover:opacity-90 active:opacity-80',
        secondary: 'bg-fill text-label hover:bg-fill-selected active:bg-fill-pressed',
        plain: 'text-label hover:bg-fill-hover active:bg-fill-pressed',
        danger: 'bg-fill text-danger hover:bg-fill-selected active:bg-fill-pressed',
      },
      size: { sm: 'h-6 px-2 text-ui-sm', md: 'h-7 px-3 text-ui' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export const iconButtonVariants = cva(
  `inline-flex shrink-0 items-center justify-center rounded-control text-label-secondary transition-colors duration-fast hover:text-label ${FOCUS_RING} ${DISABLED}`,
  {
    variants: {
      variant: {
        plain: 'hover:bg-fill-hover active:bg-fill-pressed',
        secondary: 'bg-fill hover:bg-fill-selected active:bg-fill-pressed',
        // The one filled button of an area when it has no words (Send).
        primary: 'bg-emphasis text-on-emphasis hover:text-on-emphasis hover:opacity-90 active:opacity-80',
      },
      size: { sm: 'h-6 w-6', md: 'h-7 w-7' },
      // Whether a toggle (aria-pressed) shows the selected fill. A toggle whose icon already
      // shows the state (a filled star) turns it off and keeps aria-pressed.
      pressedFill: { true: '', false: '' },
    },
    compoundVariants: [
      // The pressed fill stays under the pointer and still darkens on press-down.
      {
        variant: 'plain',
        pressedFill: true,
        className: 'aria-pressed:bg-fill-selected aria-pressed:text-label aria-pressed:hover:bg-fill-selected aria-pressed:active:bg-fill-pressed',
      },
    ],
    defaultVariants: { variant: 'plain', size: 'md', pressedFill: true },
  },
);
