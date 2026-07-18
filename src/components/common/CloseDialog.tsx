import { useState, useEffect } from 'react';
import { useI18n } from '@/i18n';
import { X, Minus, AlertTriangle } from 'lucide-react';

interface CloseDialogProps {
  open: boolean;
  hasRunningAgent: boolean;
  onQuit: () => void;
  onMinimize: () => void;
  onCancel: () => void;
  onCloseActionChange: (action: 'ask' | 'minimize' | 'quit') => void;
}

export default function CloseDialog({
  open,
  hasRunningAgent,
  onQuit,
  onMinimize,
  onCancel,
  onCloseActionChange,
}: CloseDialogProps) {
  const { t } = useI18n();
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const handleQuit = () => {
    if (remember) onCloseActionChange('quit');
    onQuit();
  };

  const handleMinimize = () => {
    if (remember) onCloseActionChange('minimize');
    onMinimize();
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="relative bg-[var(--abu-bg-base)] rounded-2xl shadow-2xl ring-1 ring-black/8 w-[400px] p-7 animate-in zoom-in-95 duration-150">
        <button
          onClick={onCancel}
          className="absolute top-4 right-4 p-1 rounded-md text-[var(--abu-text-placeholder)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
        <h3 className="text-h-sm font-semibold text-[var(--abu-text-primary)] mb-1.5">
          {t.windowClose.title}
        </h3>
        <p className="text-body text-[var(--abu-text-muted)] leading-relaxed mb-3">
          {t.windowClose.message}
        </p>
        {hasRunningAgent && (
          <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-lg bg-[var(--abu-warning-bg)] border border-[var(--abu-warning)]">
            <AlertTriangle className="h-3.5 w-3.5 text-[var(--abu-warning)] mt-0.5 shrink-0" />
            <p className="text-minor text-[var(--abu-warning)] leading-snug">
              {t.windowClose.agentRunningWarning}
            </p>
          </div>
        )}

        {/* Footer: checkbox left, buttons right */}
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-[var(--abu-border-hover)] text-[var(--abu-clay)] focus:ring-[var(--abu-clay)] accent-[var(--abu-clay)]"
            />
            <span className="text-minor text-[var(--abu-text-muted)]">
              {t.windowClose.rememberChoice}
            </span>
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={handleMinimize}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-body font-medium border border-[var(--abu-border)] bg-[var(--abu-bg-base)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)] transition-colors"
            >
              <Minus className="h-3.5 w-3.5" />
              {t.windowClose.minimize}
            </button>
            <button
              onClick={handleQuit}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-body font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              {t.windowClose.quit}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
