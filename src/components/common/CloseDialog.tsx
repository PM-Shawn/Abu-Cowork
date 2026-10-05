import { useState } from 'react';
import { Button } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { Dialog } from '@/components/ds/dialog';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { useI18n } from '@/i18n';

interface CloseDialogProps {
  open: boolean;
  hasRunningAgent: boolean;
  onQuit: () => void;
  onMinimize: () => void;
  onCancel: () => void;
  onCloseActionChange: (action: 'ask' | 'minimize' | 'quit') => void;
}

/**
 * Asked when the user closes the window: quit, or keep Abu in the tray. A question about what
 * is on screen, so it stacks over an open window or an approval and answers only itself. An
 * approval that arrives while it is open takes the page; the question comes back, as it was,
 * once that approval has been answered.
 *
 * Escape, the corner button and a press around it cancel. Only its two buttons answer, and the
 * choice is remembered only together with the answer. It opens on the answer that ends nothing.
 */
export default function CloseDialog({
  open,
  hasRunningAgent,
  onQuit,
  onMinimize,
  onCancel,
  onCloseActionChange,
}: CloseDialogProps) {
  const { t } = useI18n();
  // Lives as long as the app does: the tick is still there the next time the question is asked.
  const [remember, setRemember] = useState(false);

  // The question stays on the page while it fades out. Once it has been answered or cancelled,
  // a key on the button that still has the focus answers nothing.
  const handleQuit = () => {
    if (!open) return;
    if (remember) onCloseActionChange('quit');
    onQuit();
  };

  const handleMinimize = () => {
    if (!open) return;
    if (remember) onCloseActionChange('minimize');
    onMinimize();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onCancel(); }}
      role="alertdialog"
      size="sm"
      closeButton
      title={t.windowClose.title}
      description={t.windowClose.message}
      initialFocus={(content) => content.querySelector<HTMLElement>('[data-close-minimize]')}
      footer={(
        <div className="flex w-full items-center justify-between gap-2">
          <Checkbox checked={remember} onCheckedChange={setRemember} label={t.windowClose.rememberChoice} />
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" icon={AppIcons.remove} data-close-minimize="" onClick={handleMinimize}>
              {t.windowClose.minimize}
            </Button>
            <Button variant="primary" icon={AppIcons.close} onClick={handleQuit}>
              {t.windowClose.quit}
            </Button>
          </div>
        </div>
      )}
    >
      {hasRunningAgent && <InlineMessage tone="warning">{t.windowClose.agentRunningWarning}</InlineMessage>}
    </Dialog>
  );
}
