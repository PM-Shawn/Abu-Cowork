import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { Button } from './button';
import { AppIcons } from './icons';
import { StatusIcon } from './status-icon';

// F13: a task that cannot be read shows why and a Retry button; the rest of the app keeps working.
// `busy` is for the time the retry is running: the button stays where it is and focusable, and
// takes no press (Button busy).
export function LoadError({ reason, onRetry, busy = false }: { reason: ReactNode; onRetry: () => void; busy?: boolean }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-8 text-center">
      <StatusIcon tone="danger" size="lg" />
      <p className="max-w-96 text-ui text-label">{reason}</p>
      <Button icon={AppIcons.retry} busy={busy} onClick={onRetry}>{t.common.retry}</Button>
    </div>
  );
}
