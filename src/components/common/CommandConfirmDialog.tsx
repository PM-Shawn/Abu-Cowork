import { useEffect, useCallback } from 'react';
import { AlertTriangle, ShieldAlert, ShieldX, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import type { DangerLevel } from '@/core/tools/commandSafety';

export interface CommandConfirmRequest {
  command: string;
  level: DangerLevel;
  reason: string;
}

interface CommandConfirmDialogProps {
  request: CommandConfirmRequest;
  onConfirm: () => void;
  onCancel: () => void;
}

const levelConfig = {
  warn: {
    icon: AlertTriangle,
    iconColor: 'text-[var(--abu-warning)]',
    bgColor: 'bg-[var(--abu-warning-bg)]',
    borderColor: 'border-[var(--abu-warning)]',
    titleKey: 'title' as const,
    descKey: 'description' as const,
  },
  danger: {
    icon: ShieldAlert,
    iconColor: 'text-[var(--abu-danger)]',
    bgColor: 'bg-[var(--abu-danger-bg)]',
    borderColor: 'border-[var(--abu-danger)]',
    titleKey: 'titleDanger' as const,
    descKey: 'descriptionDanger' as const,
  },
  block: {
    icon: ShieldX,
    iconColor: 'text-[var(--abu-danger)]',
    bgColor: 'bg-[var(--abu-danger-bg)]',
    borderColor: 'border-[var(--abu-danger)]',
    titleKey: 'titleBlock' as const,
    descKey: 'descriptionBlock' as const,
  },
  safe: {
    icon: AlertTriangle,
    iconColor: 'text-[var(--abu-success)]',
    bgColor: 'bg-[var(--abu-success-bg)]',
    borderColor: 'border-[var(--abu-success)]',
    titleKey: 'title' as const,
    descKey: 'description' as const,
  },
};

export default function CommandConfirmDialog({
  request,
  onConfirm,
  onCancel,
}: CommandConfirmDialogProps) {
  const { t } = useI18n();
  const config = levelConfig[request.level];
  const Icon = config.icon;
  const isBlocked = request.level === 'block';

  // Close on Escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    }
  }, [onCancel]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md mx-4 bg-[var(--abu-bg-base)] rounded-2xl shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="relative px-6 pt-6 pb-4 shrink-0">
          <button
            onClick={onCancel}
            className="absolute top-4 right-4 p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>

          <div className="flex items-start gap-4">
            <div className={`p-3 rounded-xl ${config.bgColor}`}>
              <Icon className={`h-6 w-6 ${config.iconColor}`} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-h-md font-semibold text-[var(--abu-text-primary)]">
                {t.commandConfirm[config.titleKey]}
              </h2>
              <p className="text-body text-[var(--abu-text-tertiary)] mt-0.5">
                {t.commandConfirm[config.descKey]}
              </p>
            </div>
          </div>
        </div>

        {/* Scrollable body: command + reason */}
        <div className="flex-1 overflow-y-auto min-h-0 px-6 pb-4">
          {/* Command display */}
          <div className="px-4 py-3 bg-[#1a1a1a] rounded-lg border border-[#333]">
            <code className="text-body text-[#e0e0e0] font-mono break-all whitespace-pre-wrap">
              {request.command}
            </code>
          </div>

          {/* Reason */}
          {request.reason && (
            <div className={`mt-4 p-3 ${config.bgColor} border ${config.borderColor} rounded-lg`}>
              <div className="flex gap-2">
                <Icon className={`h-4 w-4 ${config.iconColor} shrink-0 mt-0.5`} />
                <p className={`text-minor ${config.iconColor.replace('text-', 'text-').replace('-500', '-700').replace('-600', '-800')} leading-relaxed`}>
                  {request.reason}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3 px-6 py-6 shrink-0 border-t border-[var(--abu-bg-muted)]">
          <Button
            variant="outline"
            onClick={onCancel}
            className="flex-1 h-10 text-body border-[var(--abu-border-hover)] hover:bg-[var(--abu-bg-muted)]"
          >
            {t.commandConfirm.cancel}
          </Button>
          {!isBlocked && (
            <Button
              onClick={onConfirm}
              className={`flex-1 h-10 text-body ${
                request.level === 'danger'
                  ? 'bg-[var(--abu-danger-solid)] hover:opacity-90'
                  : 'bg-[var(--abu-text-primary)] hover:bg-[var(--abu-text-secondary)]'
              } text-white`}
            >
              {t.commandConfirm.confirm}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
