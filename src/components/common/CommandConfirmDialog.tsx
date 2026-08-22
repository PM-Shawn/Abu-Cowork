import { useEffect, useCallback } from 'react';
import { AlertTriangle, ShieldAlert, ShieldX, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { mayOfferPersistentGrant } from '@/core/permissions/alwaysAskPolicy';
import type { DangerLevel } from '@/core/tools/commandSafety';

export interface CommandConfirmRequest {
  command: string;
  level: DangerLevel;
  reason: string;
  /** Selects the wording — see ConfirmationInfo.kind. */
  kind?: 'command' | 'browser' | 'self-extension';
  /** Browser confirmations: exact origin of the action, when resolved. */
  browserOrigin?: string;
  /** Browser confirmations: whether "always allow this site" may be offered. */
  allowPersistentGrant?: boolean;
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
  // "Always allow this site": persist the verdict, then resolve like a normal
  // confirm. The persistent grant is the dialog's own side effect — the
  // approval pipeline stays a plain boolean.
  // `allowPersistentGrant` is the requester's ceiling; `mayOfferPersistentGrant`
  // is the floor that high-consequence actions can never rise above. Both must
  // agree before a "forever" button appears.
  const offerSiteGrant =
    request.kind === 'browser' && !!request.browserOrigin && mayOfferPersistentGrant(request);
  const handleAlwaysAllowSite = useCallback(() => {
    if (request.browserOrigin) {
      useSettingsStore.getState().setBrowserSitePermission(request.browserOrigin, 'allowed');
    }
    onConfirm();
  }, [request.browserOrigin, onConfirm]);

  // "Block this site" is the mirror of "always allow", and it is offered
  // wherever an origin is known — including the cases that may NOT be granted
  // permanently (scripting tools, block-level actions). Tightening is always
  // safe to make one click away; the asymmetry is deliberate, since the only
  // way a user can currently stop being asked is to approve.
  const offerSiteBlock = request.kind === 'browser' && !!request.browserOrigin;
  const handleBlockSite = useCallback(() => {
    if (request.browserOrigin) {
      useSettingsStore.getState().setBrowserSitePermission(request.browserOrigin, 'denied');
    }
    // Blocking also refuses the pending action — the user said "not this site",
    // which necessarily includes the request they are looking at.
    onCancel();
  }, [request.browserOrigin, onCancel]);

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
    <div data-electron-no-drag className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
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
                {request.kind === 'browser'
                  ? t.commandConfirm.browserTitle
                  : request.kind === 'self-extension'
                    ? t.commandConfirm.selfExtensionTitle
                    : t.commandConfirm[config.titleKey]}
              </h2>
              <p className="text-body text-[var(--abu-text-tertiary)] mt-0.5">
                {request.kind === 'browser'
                  ? t.commandConfirm.browserDescription
                  : request.kind === 'self-extension'
                    ? t.commandConfirm.selfExtensionDescription
                    : t.commandConfirm[config.descKey]}
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
        <div className="flex flex-col gap-3 px-6 py-6 shrink-0 border-t border-[var(--abu-bg-muted)]">
          <div className="flex gap-3">
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
              {offerSiteGrant ? t.commandConfirm.browserAllowOnce : t.commandConfirm.confirm}
            </Button>
          )}
          {!isBlocked && offerSiteGrant && (
            // The more consequential choice stays visually secondary: the
            // conversation-scoped button keeps the primary styling so the
            // safer default is the visually dominant one.
            <Button
              variant="outline"
              onClick={handleAlwaysAllowSite}
              className="flex-1 h-10 text-body border-[var(--abu-border-hover)] hover:bg-[var(--abu-bg-muted)]"
              title={request.browserOrigin}
            >
              {t.commandConfirm.browserAlwaysAllowSite}
            </Button>
          )}
          </div>
          {offerSiteBlock && (
            // Second row, ghost styling: a standing block is consequential but
            // never the action we nudge toward, so it stays visually quiet
            // while remaining reachable without leaving the dialog.
            <Button
              variant="ghost"
              onClick={handleBlockSite}
              className="h-8 w-full text-minor text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)]"
              title={request.browserOrigin}
            >
              {t.commandConfirm.browserBlockSite}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
