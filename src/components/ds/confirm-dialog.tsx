import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { Button } from './button';
import { Dialog } from './dialog';

// A question is a `role="alertdialog"` window: like an approval, it takes no pointer press that
// began before it could be read (see dialog.tsx). Its confirming button sits where the button that
// asked, or the button of the question before it, was.
export function ConfirmDialog({ open, title, message, confirmLabel, tone = 'default', onCloseAutoFocus, onResult }: {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  // Dialog's hook of the same name: runs once the question has left the page.
  onCloseAutoFocus?: (event: Event) => void;
  onResult: (confirmed: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onResult(false); }}
      onCloseAutoFocus={onCloseAutoFocus}
      title={title}
      description={message}
      size="sm"
      role="alertdialog"
      footer={(
        <>
          <Button variant="secondary" onClick={() => onResult(false)}>{t.common.cancel}</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={() => onResult(true)}>{confirmLabel}</Button>
        </>
      )}
    />
  );
}
