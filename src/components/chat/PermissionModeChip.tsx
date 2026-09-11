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
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${t.settings.permissionMode}: ${currentLabel}`}
        /* Just the mode, matching the visible label — NOT the title's
           "默认权限模式: …" phrasing, which is the settings dialog control's
           accessible name and would make `getByRole` ambiguous across the two
           (tests/e2e/security-settings.spec.ts locates it by exactly that).
           The name here is unchanged from when it came from the label text;
           the point of spelling it out is that the label goes display:none at
           narrow widths, which would otherwise take the name with it. */
        aria-label={currentLabel}
        className={cn(
          'btn-ghost flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-minor font-normal transition-colors hover:bg-[var(--abu-bg-hover)]',
          MODE_CHIP_COLOR[effectiveMode] ?? MODE_CHIP_COLOR.standard
        )}
      >
        <CurrentIcon className="h-3.5 w-3.5 shrink-0" />
        {/* Second rung of the composer toolbar's degradation ladder: in a
            narrow pane the mode reads well enough from its icon (the risk ramp
            is also colored gray → clay → red), and the full label stays in the
            tooltip and `aria-label`. The query resolves against the composer
            toolbar's `@container`; anywhere without one it never matches, so
            the label simply always shows. */}
        <span className="whitespace-nowrap @max-[420px]:hidden">{currentLabel}</span>
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
                    ? 'bg-[var(--abu-bg-hover)] text-[var(--abu-text-primary)]'
                    : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]'
                )}
              >
                <Icon className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-body font-medium">{info.label}</span>
                  <span className="text-caption text-[var(--abu-text-muted)] leading-snug">
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
