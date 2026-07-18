import { useSyncExternalStore } from 'react';
import { Monitor, Square } from 'lucide-react';
import { subscribeCUStatus, getCUStatusSnapshot } from '@/core/agent/computerUseStatus';
import { useI18n, format } from '@/i18n';

export default function ComputerUseStatusBar({ onStop }: { onStop?: () => void }) {
  const { t } = useI18n();
  const status = useSyncExternalStore(subscribeCUStatus, getCUStatusSnapshot);

  if (status.status !== 'active') return null;

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-[var(--abu-info-bg)] border-b border-[var(--abu-info)] text-body">
      <div className="flex items-center gap-2 text-[var(--abu-info)]">
        <Monitor className="h-4 w-4 animate-pulse" />
        <span>
          {t.computerUse.controlling}
          {status.stepCount > 0 && ` ${format(t.computerUse.step, { step: status.stepCount })}`}
        </span>
      </div>
      {onStop && (
        <button
          onClick={onStop}
          className="flex items-center gap-1 px-2 py-1 text-minor text-[var(--abu-danger)] hover:text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)] rounded transition-colors"
        >
          <Square className="h-3 w-3" />
          {t.computerUse.stop}
        </button>
      )}
    </div>
  );
}
