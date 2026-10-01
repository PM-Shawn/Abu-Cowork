import { useI18n } from '@/i18n';
import { Button } from './button';
import { Dialog } from './dialog';

export function ConfirmDialog({ open, title, message, confirmLabel, tone = 'default', onResult }: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  onResult: (confirmed: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onResult(false); }}
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
