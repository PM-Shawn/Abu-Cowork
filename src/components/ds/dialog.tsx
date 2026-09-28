import { AlertDialog as AlertDialogPrimitive, Dialog as DialogPrimitive } from 'radix-ui';
import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { LayerScope } from './layer';
import { useLayer, useLayerContainer, useOpenState } from './layer-context';
import { DIALOG_BOX, DIALOG_MOTION, SCRIM_MOTION } from './styles';

const WIDTH = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl' } as const;

export function DialogClose(props: ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close {...props} />;
}

// One dialog at a time (LayerProvider). Escape, the scrim and DialogClose all close it,
// except while `dirty`: then the user is asked whether to discard what they typed.
export function Dialog({
  title, description, children, footer, trigger, open, defaultOpen = false, onOpenChange,
  dirty = false, size = 'md', role = 'dialog',
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  trigger?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  dirty?: boolean;
  size?: keyof typeof WIDTH;
  role?: 'dialog' | 'alertdialog';
}) {
  const { t } = useI18n();
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  const dirtyRef = useRef(dirty);
  useLayoutEffect(() => { dirtyRef.current = dirty; });

  const askToDiscard = (onDiscard: () => void) => setPendingDiscard(() => onDiscard);
  const requestClose = () => {
    if (dirtyRef.current) askToDiscard(() => setOpen(false));
    else setOpen(false);
  };
  const discard = () => {
    const onDiscard = pendingDiscard;
    setPendingDiscard(null);
    if (!onDiscard) throw new Error('No discard is pending');
    onDiscard();
  };

  const { id, onCloseAutoFocus } = useLayer(role === 'alertdialog' ? 'alert' : 'dialog', isOpen, setOpen, { isDirty: () => dirtyRef.current, confirmDiscard: askToDiscard });

  return (
    <>
      <DialogPrimitive.Root open={isOpen} onOpenChange={(next) => (next ? setOpen(true) : requestClose())}>
        {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
        <DialogPrimitive.Portal container={container}>
          {/* eslint-disable-next-line no-restricted-syntax -- Dialog owns the app's only scrim */}
          <DialogPrimitive.Overlay data-ds-motion data-electron-no-drag className={cn('fixed inset-0 z-dialog bg-scrim', SCRIM_MOTION)} />
          <DialogPrimitive.Content
            data-ds-layer
            data-ds-motion
            data-electron-no-drag
            role={role}
            onCloseAutoFocus={onCloseAutoFocus}
            {...(description ? {} : { 'aria-describedby': undefined })}
            className={cn(DIALOG_BOX, WIDTH[size], DIALOG_MOTION)}
          >
            <LayerScope id={id}>
              <DialogPrimitive.Title className="text-title text-label">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-ui text-label-secondary">{description}</DialogPrimitive.Description>
              )}
              {children && <div className="mt-4 text-ui text-label">{children}</div>}
              {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
            </LayerScope>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <AlertDialogPrimitive.Root open={pendingDiscard !== null} onOpenChange={(next) => { if (!next) setPendingDiscard(null); }}>
        <AlertDialogPrimitive.Portal container={container}>
          <AlertDialogPrimitive.Content data-ds-layer data-ds-motion data-electron-no-drag className={cn(DIALOG_BOX, WIDTH.sm, DIALOG_MOTION)}>
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
