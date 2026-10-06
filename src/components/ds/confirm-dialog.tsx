import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { Button } from './button';
import { Dialog } from './dialog';
import { TOAST_SETTLE_MS } from './styles';

export function ConfirmDialog({ open, title, message, confirmLabel, tone = 'default', settles = false, onCloseAutoFocus, onResult }: {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  // The question took the place of another that was on screen. A pointer press that was on its
  // way to the first question's button would land on this one's at the same spot, so its buttons
  // take no pointer press for a moment (the interval of the notification list). The keyboard is
  // not held back: the question opens on Cancel and the focus says which button is meant. It is a
  // guard, not a state, so nothing looks disabled.
  settles?: boolean;
  // Dialog's hook of the same name: runs once the question has left the page.
  onCloseAutoFocus?: (event: Event) => void;
  onResult: (confirmed: boolean) => void;
}) {
  const { t } = useI18n();
  // Time that only moves forward. Read once, when this question is first drawn.
  const [heldUntil] = useState(() => (settles ? performance.now() + TOAST_SETTLE_MS : 0));
  // The start of a press counts: one that began before the question had settled was aimed at
  // what was there before, wherever and whenever it ends.
  const pressBeganEarly = useRef(false);
  const pressBegins = () => { pressBeganEarly.current = performance.now() < heldUntil; };
  // A click raised by Enter or Space reports detail 0.
  const answer = (confirmed: boolean) => (event: MouseEvent) => {
    const early = pressBeganEarly.current;
    pressBeganEarly.current = false;
    if (event.detail !== 0 && (early || performance.now() < heldUntil)) return;
    onResult(confirmed);
  };
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
          <Button variant="secondary" onPointerDown={pressBegins} onClick={answer(false)}>{t.common.cancel}</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onPointerDown={pressBegins} onClick={answer(true)}>{confirmLabel}</Button>
        </>
      )}
    />
  );
}
