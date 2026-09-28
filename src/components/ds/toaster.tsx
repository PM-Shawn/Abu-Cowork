import { createPortal } from 'react-dom';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Toast } from '@/stores/toastStore';
import { Button, IconButton } from './button';
import { AppIcons } from './icons';
import { useLayerContainer } from './layer-context';
import { StatusIcon } from './status-icon';
import { FLOAT_SURFACE } from './styles';

export const MAX_VISIBLE_TOASTS = 3;

const TONE = { success: 'success', warning: 'warning', error: 'danger', info: 'info' } as const;

const TOAST_MOTION = 'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2 data-[state=open]:duration-base data-[state=open]:ease-enter';

// Shows toastStore's notifications; the store decides when each one expires. The list is
// not a layer and never takes Escape, so Escape keeps closing whatever dialog is open.
export function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const { t } = useI18n();
  const container = useLayerContainer();
  const visible = toasts.slice(-MAX_VISIBLE_TOASTS);
  return createPortal(
    <ol
      role="status"
      aria-live="polite"
      aria-label={t.designSystem.notifications}
      data-electron-no-drag
      className="fixed bottom-4 right-4 z-toast flex w-80 flex-col gap-2"
    >
      {visible.map((toast) => (
        <li key={toast.id} data-ds-motion data-state="open" className={cn('flex items-start gap-2 p-3', FLOAT_SURFACE, TOAST_MOTION)}>
          <StatusIcon tone={TONE[toast.type]} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="text-ui font-medium text-label">{toast.title}</p>
            {toast.message && <p className="mt-1 text-ui-sm text-label-secondary">{toast.message}</p>}
            {toast.actions && toast.actions.length > 0 && (
              <div className="mt-2 flex gap-2">
                {toast.actions.map((action) => (
                  <Button
                    key={action.label}
                    size="sm"
                    onClick={() => {
                      action.onClick();
                      onDismiss(toast.id);
                    }}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <IconButton icon={AppIcons.close} label={t.common.close} size="sm" onClick={() => onDismiss(toast.id)} />
        </li>
      ))}
    </ol>,
    container ?? document.body,
  );
}
