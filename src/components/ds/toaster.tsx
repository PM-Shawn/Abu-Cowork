import { Toast as ToastPrimitive } from 'radix-ui';
import { createPortal } from 'react-dom';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Toast } from '@/stores/toastStore';
import { Button, IconButton } from './button';
import { AppIcons } from './icons';
import { useLayerContainer } from './layer-context';
import { StatusIcon } from './status-icon';
import { FLOAT_MOTION, FLOAT_SURFACE } from './styles';

export const MAX_VISIBLE_TOASTS = 3;

const TONE = { success: 'success', warning: 'warning', error: 'danger', info: 'info' } as const;

// Shows toastStore's notifications. The store decides when each one expires; Radix
// timers stay off (duration Infinity) so there is a single clock.
export function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const { t } = useI18n();
  const container = useLayerContainer();
  const visible = toasts.slice(-MAX_VISIBLE_TOASTS);
  return (
    <ToastPrimitive.Provider duration={Number.POSITIVE_INFINITY} swipeDirection="right" label={t.designSystem.notifications}>
      {visible.map((toast) => (
        <ToastPrimitive.Root
          key={toast.id}
          open
          onOpenChange={(open) => { if (!open) onDismiss(toast.id); }}
          data-ds-motion
          className={cn('flex items-start gap-2 p-3', FLOAT_SURFACE, FLOAT_MOTION)}
        >
          <StatusIcon tone={TONE[toast.type]} size="sm" />
          <div className="min-w-0 flex-1">
            <ToastPrimitive.Title className="text-ui font-medium text-label">{toast.title}</ToastPrimitive.Title>
            {toast.message && <ToastPrimitive.Description className="mt-1 text-ui-sm text-label-secondary">{toast.message}</ToastPrimitive.Description>}
            {toast.actions && toast.actions.length > 0 && (
              <div className="mt-2 flex gap-2">
                {toast.actions.map((action) => (
                  <ToastPrimitive.Action key={action.label} altText={action.label} asChild>
                    <Button size="sm" onClick={action.onClick}>{action.label}</Button>
                  </ToastPrimitive.Action>
                ))}
              </div>
            )}
          </div>
          <ToastPrimitive.Close asChild>
            <IconButton icon={AppIcons.close} label={t.common.close} size="sm" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      {createPortal(
        <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-toast flex w-80 flex-col gap-2 outline-none" />,
        container ?? document.body,
      )}
    </ToastPrimitive.Provider>
  );
}
