import { AlertDialog as AlertDialogPrimitive, Dialog as DialogPrimitive, VisuallyHidden } from 'radix-ui';
import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { isMacOS } from '@/utils/platform';
import { Button, IconButton } from './button';
import { AppIcons } from './icons';
import { LayerScope } from './layer';
import { InDialogContext, useLayer, useLayerContainer, useOpenState } from './layer-context';
import { DIALOG_BOX, DIALOG_CLOSING, DIALOG_MOTION, DIALOG_PAGE, SCRIM_MOTION } from './styles';

const WIDTH = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-3xl' } as const;
interface PendingDiscard { onDiscard: () => void; onKeep?: () => void }
// Hooks for tests and for the window-drag guard; nothing else reaches the dialog box.
export type DataAttributes = { [key: `data-${string}`]: string | undefined };
// `top` keeps the top edge still while the content grows or shrinks (search as you type).
// Its height limit counts from that edge, so the dialog still ends 48px above the window's bottom.
const PLACEMENT = { center: '', top: 'top-1/7 translate-y-0 max-h-[calc(100dvh*6/7-3rem)]' } as const;

export function DialogClose(props: ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close {...props} />;
}

// One dialog at a time (LayerProvider). Escape, the scrim, the close button and DialogClose
// all close it, except while `dirty`: then the user is asked whether to discard what they typed.
// Content taller than the window scrolls inside the dialog; the title and the footer stay put.
export function Dialog({
  title, description, children, footer, trigger, open, defaultOpen = false, onOpenChange,
  dirty = false, size = 'md', placement = 'center', role = 'dialog', titleHidden = false,
  closeButton: closeButtonAsked = false, dismissible = true, contentProps, onCloseAutoFocus: callerCloseAutoFocus,
}: {
  title: ReactNode;
  // Keeps the title as the accessible name without showing it.
  titleHidden?: boolean;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  trigger?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  dirty?: boolean;
  // `page` is the settings window: it fills a fixed box and its content does its own scrolling.
  size?: keyof typeof WIDTH | 'page';
  placement?: keyof typeof PLACEMENT;
  role?: 'dialog' | 'alertdialog';
  // A close button in the top right corner; data attributes given here go on that button.
  closeButton?: boolean | DataAttributes;
  // false: only the dialog's own buttons (and DialogClose) close it. Escape and a press outside
  // do nothing and there is no close button; the scrim still blocks the window behind it. For a
  // one-time question that a stray key or click must not skip. The layer registry can still
  // close it: when the dialog it was asked over goes away, or another dialog takes its place.
  dismissible?: boolean;
  contentProps?: DataAttributes;
  // Runs after the layer's own handler once the dialog has gone; call event.preventDefault()
  // there to put focus somewhere other than where it was before the dialog opened. When
  // event.defaultPrevented is already true, another dialog has taken the focus: leave it alone.
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useI18n();
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
  // The discard question that is on screen. The ref is what the handlers read: Discard and
  // the question's own close arrive in one event, and only the first of them may answer.
  const [discardAsked, setDiscardAsked] = useState(false);
  const pendingDiscard = useRef<PendingDiscard | null>(null);
  const dirtyRef = useRef(dirty);
  useLayoutEffect(() => { dirtyRef.current = dirty; });

  const takePendingDiscard = () => {
    const pending = pendingDiscard.current;
    pendingDiscard.current = null;
    setDiscardAsked(false);
    return pending;
  };
  // Returns a function that takes this question back without answering it.
  const askToDiscard = (onDiscard: () => void, onKeep?: () => void) => {
    const pending = { onDiscard, onKeep };
    pendingDiscard.current = pending;
    setDiscardAsked(true);
    return () => { if (pendingDiscard.current === pending) takePendingDiscard(); };
  };
  const requestClose = () => {
    if (dirtyRef.current) askToDiscard(() => setOpen(false));
    else setOpen(false);
  };
  // The question stays on the page while it fades out: a later activation finds nothing pending.
  const discard = () => { takePendingDiscard()?.onDiscard(); };
  // Keep editing, Escape, or anything else that closes the question without discarding.
  const keep = () => { takePendingDiscard()?.onKeep?.(); };

  const { id, onCloseAutoFocus, held } = useLayer(role === 'alertdialog' ? 'alert' : 'dialog', isOpen, setOpen, { isDirty: () => dirtyRef.current, confirmDiscard: askToDiscard });
  // The owner closed the dialog while the discard question was on screen (a save that was in
  // flight landed): nothing is left to discard, so the question goes unanswered.
  useLayoutEffect(() => {
    if (isOpen || !pendingDiscard.current) return;
    pendingDiscard.current = null;
    setDiscardAsked(false);
  }, [isOpen]);

  // Radix gives focus back only to a Dialog.Trigger. A dialog opened by code (search,
  // useConfirm(), the discard question) has none, so it would leave focus on the page
  // body; these give focus back to whatever had it when the dialog opened.
  const returnTo = useRef<HTMLElement | null>(null);
  const discardReturnTo = useRef<HTMLElement | null>(null);
  const remember = (target: { current: HTMLElement | null }) => {
    target.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const giveFocusBack = (target: { current: HTMLElement | null }, event: Event, hasTrigger: boolean) => {
    const element = target.current;
    target.current = null;
    // A caller or the layer registry that already chose where focus goes keeps its choice.
    if (event.defaultPrevented || hasTrigger) return;
    event.preventDefault();
    if (element?.isConnected) element.focus();
  };

  const closeButton = dismissible && closeButtonAsked;
  // Radix asks before it dismisses; a prevented event leaves the dialog open.
  const stay = dismissible ? undefined : (event: Event) => event.preventDefault();
  const page = size === 'page';
  const box = page ? cn(DIALOG_PAGE, isMacOS() ? 'top-12' : 'top-6') : cn(DIALOG_BOX, WIDTH[size], PLACEMENT[placement]);

  return (
    <>
      {/* Held by the layer registry: open as far as the owner knows, not on the page yet. */}
      <DialogPrimitive.Root open={isOpen && !held} onOpenChange={(next) => (next ? setOpen(true) : requestClose())}>
        {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
        <DialogPrimitive.Portal container={container}>
          {/* eslint-disable-next-line no-restricted-syntax -- Dialog owns the app's only scrim */}
          <DialogPrimitive.Overlay data-ds-motion data-electron-no-drag className={cn('fixed inset-0 z-dialog bg-scrim', SCRIM_MOTION)} />
          <DialogPrimitive.Content
            {...contentProps}
            data-ds-layer
            data-ds-motion
            data-electron-no-drag
            role={role}
            onEscapeKeyDown={stay}
            onInteractOutside={stay}
            onOpenAutoFocus={() => remember(returnTo)}
            onCloseAutoFocus={(event) => {
              // The layer's handler first: it prevents the default when the registry
              // closed this dialog to make room for another. Then the caller's choice.
              onCloseAutoFocus(event);
              callerCloseAutoFocus?.(event);
              giveFocusBack(returnTo, event, trigger !== undefined);
            }}
            {...(description ? {} : { 'aria-describedby': undefined })}
            className={cn(box, DIALOG_MOTION, DIALOG_CLOSING)}
          >
            <LayerScope id={id}>
              <InDialogContext.Provider value>
                {titleHidden ? (
                  // Still the dialog's accessible name, for a dialog whose content says what it is (search).
                  <VisuallyHidden.Root asChild>
                    <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
                  </VisuallyHidden.Root>
                ) : (
                  // With a close button the title stops short of the corner the button sits in.
                  <DialogPrimitive.Title className={cn('text-title text-label', closeButton && 'pr-8')}>{title}</DialogPrimitive.Title>
                )}
                {description && (
                  <DialogPrimitive.Description className="mt-1 text-ui text-label-secondary">{description}</DialogPrimitive.Description>
                )}
                {children && (page ? (
                  <div className="min-h-0 flex-1 text-ui text-label">{children}</div>
                ) : (
                  <div className={cn('flex min-h-0 flex-col', !titleHidden && 'mt-4')}>
                    {/* The 4px of padding keeps focus rings from being cut off by the scroll box. */}
                    <div className="-m-1 min-h-0 overflow-y-auto p-1 text-ui text-label">{children}</div>
                  </div>
                ))}
                {footer && <div className="mt-6 flex shrink-0 justify-end gap-2">{footer}</div>}
                {/* Last in the content, so the dialog opens with focus on its first control. */}
                {closeButton && (
                  <span className="absolute right-3 top-3 flex">
                    <DialogPrimitive.Close asChild>
                      <IconButton icon={AppIcons.close} label={t.common.close} {...(closeButton === true ? {} : closeButton)} />
                    </DialogPrimitive.Close>
                  </span>
                )}
              </InDialogContext.Provider>
            </LayerScope>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <AlertDialogPrimitive.Root open={discardAsked} onOpenChange={(next) => { if (!next) keep(); }}>
        <AlertDialogPrimitive.Portal container={container}>
          <AlertDialogPrimitive.Content
            data-ds-layer
            data-ds-motion
            data-electron-no-drag
            onOpenAutoFocus={() => remember(discardReturnTo)}
            onCloseAutoFocus={(event) => giveFocusBack(discardReturnTo, event, false)}
            className={cn(DIALOG_BOX, WIDTH.sm, DIALOG_MOTION, DIALOG_CLOSING)}
          >
            <AlertDialogPrimitive.Title className="text-title text-label">{t.designSystem.discardTitle}</AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="mt-1 text-ui text-label-secondary">
              {t.designSystem.discardMessage}
            </AlertDialogPrimitive.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialogPrimitive.Cancel asChild>
                <Button variant="secondary">{t.designSystem.keepEditing}</Button>
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action asChild>
                <Button variant="danger" onClick={discard}>{t.designSystem.discard}</Button>
              </AlertDialogPrimitive.Action>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </>
  );
}
