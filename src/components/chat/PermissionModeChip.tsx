import { useState, useRef, useEffect } from 'react';
import { Hand, ScanEye, AlertTriangle } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { PermissionMode } from '@/core/permissions/permissionMode';

interface ModeOption {
  mode: PermissionMode;
  Icon: React.FC<{ className?: string }>;
}

const MODE_OPTIONS: ModeOption[] = [
  { mode: 'standard', Icon: Hand },
  { mode: 'smart', Icon: ScanEye },
  { mode: 'autonomous', Icon: AlertTriangle },
];

// Collapsed chip color per mode (icon follows text via currentColor): risk ramp
// gray → clay → red. Dropdown list items stay neutral.
const MODE_CHIP_COLOR: Record<PermissionMode, string> = {
  standard: 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]',
  smart: 'text-[var(--abu-clay)] hover:text-[var(--abu-clay-hover)]',
  autonomous: 'text-[var(--abu-danger)]',
};

interface Props {
  conversationId: string | null;
}

export default function PermissionModeChip({ conversationId }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useI18n();

  const convMode = useChatStore(
    (s) => (conversationId ? s.conversations[conversationId]?.permissionMode : s.pendingPermissionMode)
  );
  const globalMode = useSettingsStore((s) => s.permissionMode);
  const effectiveMode = convMode ?? globalMode;

  const setConversationPermissionMode = useChatStore((s) => s.setConversationPermissionMode);
  const setPendingPermissionMode = useChatStore((s) => s.setPendingPermissionMode);

  const modeLabels: Record<PermissionMode, { label: string; description: string }> = {
    standard: { label: t.settings.permissionModeStandard, description: t.settings.permissionModeStandardDesc },
    smart: { label: t.settings.permissionModeSmart, description: t.settings.permissionModeSmartDesc },
    autonomous: { label: t.settings.permissionModeAutonomous, description: t.settings.permissionModeAutonomousDesc },
  };

  const currentLabel = modeLabels[effectiveMode]?.label ?? t.settings.permissionModeStandard;
  const CurrentIcon = MODE_OPTIONS.find((o) => o.mode === effectiveMode)?.Icon ?? Hand;

  useEffect(() => {
    if (!open) return;
    function handleOutsideClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  function handleSelect(mode: PermissionMode) {
    if (conversationId) {
      setConversationPermissionMode(conversationId, mode);
    } else {
      setPendingPermissionMode(mode);
    }
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${t.settings.permissionMode}: ${currentLabel}`}
        className={cn(
          'btn-ghost flex items-center gap-1 px-2 py-1 h-7 text-[12px] font-normal rounded-md transition-colors hover:bg-[var(--abu-bg-hover)]',
          MODE_CHIP_COLOR[effectiveMode] ?? MODE_CHIP_COLOR.standard
        )}
      >
        <CurrentIcon className="h-3.5 w-3.5 shrink-0" />
        <span>{currentLabel}</span>
      </button>

      {open && (
        <div
          className={cn(
            'absolute bottom-full left-0 mb-1.5 z-50',
            'w-64 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)]',
            'shadow-lg shadow-black/10 p-2 flex flex-col gap-1'
          )}
        >
          {MODE_OPTIONS.map(({ mode, Icon }) => {
            const info = modeLabels[mode];
            return (
              <button
                key={mode}
                onClick={() => handleSelect(mode)}
                className={cn(
                  'flex items-start gap-2.5 w-full text-left px-3 py-2.5 rounded-lg transition-colors',
                  mode === effectiveMode
                    ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                    : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]'
                )}
              >
                <Icon className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[13px] font-medium">{info.label}</span>
                  <span className="text-[11px] text-[var(--abu-text-muted)] leading-snug">
                    {info.description}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
