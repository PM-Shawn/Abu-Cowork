import { useEffect, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, ShieldAlert, ShieldX, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { format, useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { grantBrowserPermissionTargets } from '@/core/permissions/browserPermissionConfig';
import { mayOfferPersistentGrant } from '@/core/permissions/alwaysAskPolicy';
import type { DangerLevel } from '@/core/tools/commandSafety';

export interface CommandConfirmRequest {
  command: string;
  level: DangerLevel;
  reason: string;
  /** Selects the wording — see ConfirmationInfo.kind. */
  kind?: 'command' | 'browser' | 'browser-upload' | 'self-extension';
  /** Upload confirmations: how many files — see ConfirmationInfo.browserUploadFileCount. */
  browserUploadFileCount?: number;
  /** Browser confirmations: exact origin of the action, when resolved. */
  browserOrigin?: string;
  /**
   * Browser confirmations: the OTHER sites this page embeds as regions the
   * automation can address — see `ConfirmationInfo.browserEmbeddedOrigins`.
   * Named in the ask, and granted individually by "always allow".
   */
  browserEmbeddedOrigins?: string[];
  /**
   * Browser confirmations: the origin of the PAGE, when the action's own
   * target is a region inside it — see `ConfirmationInfo.browserPageOrigin`.
   */
  browserPageOrigin?: string;
  /** Browser confirmations: whether "always allow this site" may be offered. */
  browserPermissionResource?: import('@/core/permissions/browserPermissionDefaults').BrowserPermissionResource;
  browserPermissionTargets?: import('@/core/permissions/browserPermissionConfig').BrowserPermissionTarget[];
  allowPersistentGrant?: boolean;
}

/**
 * How many embedded regions one dialog will list — and therefore how many one
 * click will grant.
 *
 * An ordinary portal page can embed dozens of third-party frames (the frame
 * listing itself only stops at 40), and a prompt that printed all of them
 * would be asking for consent to a wall of text nobody reads. What is not
 * listed is not granted: the overflow is counted, said out loud, and left for
 * a separate ask.
 */
const MAX_LISTED_EMBEDDED_ORIGINS = 5;

interface CommandConfirmDialogProps {
  request: CommandConfirmRequest;
  onConfirm: () => void;
  onCancel: () => void;
  isRequestActive?: () => boolean;
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
  onConfirm: confirm,
  onCancel: cancel,
  isRequestActive,
}: CommandConfirmDialogProps) {
  const { t } = useI18n();
  const active = useRef<CommandConfirmRequest | null>(request);
  const [savingRequest, setSavingRequest] = useState<CommandConfirmRequest | null>(null);
  const [failedRequest, setFailedRequest] = useState<CommandConfirmRequest | null>(null);
  const saving = savingRequest === request;
  const saveFailed = failedRequest === request;
  const setSaving = useCallback((value: boolean) => setSavingRequest(value ? request : null), [request]);
  const setSaveFailed = useCallback((value: boolean) => setFailedRequest(value ? request : null), [request]);
  useLayoutEffect(() => { active.current = request; return () => { active.current = null; }; }, [request]);
  const current = useCallback(() => active.current === request && (isRequestActive?.() ?? true), [request, isRequestActive]);
  const onCancel = useCallback(() => { active.current = null; cancel(); }, [cancel]);
  const onConfirm = useCallback(() => { if (!saving && current()) confirm(); }, [saving, current, confirm]);
  const permissions = useSettingsStore((state) => state.browserPermissionConfigV2);
  const config = levelConfig[request.level];
  const Icon = config.icon;
  const isBlocked = request.level === 'block';
  /**
   * An upload is a browser action wearing its own wording (acceptance F5).
   *
   * Every site-scoped affordance below — the standing grant, the embedded
   * region list, the block-this-site row — reads the SAME predicate, because
   * an upload targets an origin exactly the way a click does. Only the
   * question, the line under it and the confirm verb change; splitting the
   * predicate instead of naming it is how an upload would have quietly lost
   * its「禁止此网站」 row.
   */
  const isBrowserKind = request.kind === 'browser' || request.kind === 'browser-upload';
  const isUpload = request.kind === 'browser-upload';
  /**
   * The site an upload names in its question: a HOSTNAME, and only that.
   *
   * `browserPageOrigin` is present exactly when the action's target is a
   * region embedded in some other page, so it is what tells the reader that
   * the files are going somewhere the page merely hosts — the one distinction
   * that changes whether an upload is what they meant.
   */
  const uploadHost = (() => {
    if (!request.browserOrigin) return t.commandConfirm.browserUploadHostThisSite;
    let host = request.browserOrigin;
    try {
      host = new URL(request.browserOrigin).hostname || request.browserOrigin;
    } catch {
      // A target we cannot parse is shown verbatim rather than dropped: the
      // user still has to be told where the files are going.
    }
    return request.browserPageOrigin !== undefined
      ? format(t.commandConfirm.browserUploadHostEmbedded, { host })
      : host;
  })();
  const uploadCount = request.browserUploadFileCount ?? 0;
  const uploadTitle = format(
    uploadCount === 1 ? t.commandConfirm.browserUploadTitleOne : t.commandConfirm.browserUploadTitle,
    { count: String(uploadCount), host: uploadHost },
  );
  // "Always allow this site": persist the verdict, then resolve like a normal
  // confirm. The persistent grant is the dialog's own side effect — the
  // approval pipeline stays a plain boolean.
  // `allowPersistentGrant` is the requester's ceiling; `mayOfferPersistentGrant`
  // is the floor that high-consequence actions can never rise above. Both must
  // agree before a "forever" button appears.
  const offerSiteGrant =
    isBrowserKind && !!request.browserOrigin && mayOfferPersistentGrant(request)
    && !!request.browserPermissionResource && !!request.browserPermissionTargets?.length
    && grantBrowserPermissionTargets(permissions, request.browserPermissionResource, request.browserPermissionTargets) !== null
    && (request.browserEmbeddedOrigins?.length ?? 0) <= MAX_LISTED_EMBEDDED_ORIGINS;
  /**
   * The other sites this page embeds as regions the automation can address.
   *
   * They are authorized on their OWN account — a grant for the page does not
   * cover them — so the user has to see them before approving, and "always
   * allow" writes a separate grant for each. Asking region by region would
   * turn one form into a wall of prompts; a wildcard would make the grant mean
   * something the user never agreed to. Naming them here is what keeps both
   * from happening.
   */
  const allEmbeddedOrigins = isBrowserKind
    // Never the action's own target: for a frame-targeted action that origin
    // IS one of the page's regions, and counting it twice made the button
    // promise one more region than the click covers.
    ? (request.browserEmbeddedOrigins ?? []).filter((o) => o !== request.browserOrigin)
    : [];
  /** The regions this dialog names — and, exactly, the ones it grants. */
  const embeddedOrigins = allEmbeddedOrigins.slice(0, MAX_LISTED_EMBEDDED_ORIGINS);
  const unlistedEmbeddedCount = allEmbeddedOrigins.length - embeddedOrigins.length;
  const handleAlwaysAllowSite = useCallback(async () => {
    if (!current() || saving || !offerSiteGrant || !request.browserPermissionResource || !request.browserPermissionTargets) return;
    setSaving(true); setSaveFailed(false);
    const saved = await useSettingsStore.getState().grantBrowserPermissionTargets(request.browserPermissionResource, request.browserPermissionTargets, current);
    if (!current()) return;
    setSaving(false);
    if (saved) confirm(); else setSaveFailed(true);
  }, [current, saving, offerSiteGrant, request, confirm, setSaving, setSaveFailed]);
  const alwaysAllowSiteLabel = request.browserPermissionResource === 'upload'
    ? t.settings.browserResourceGrantUpload
    : request.browserPermissionResource === 'script'
      ? t.settings.browserResourceGrantScript
      : t.settings.browserResourceGrantBrowse;

  // "Block this site" is the mirror of "always allow", and it is offered
  // wherever an origin is known — including the cases that may NOT be granted
  // permanently (scripting tools, block-level actions). Tightening is always
  // safe to make one click away; the asymmetry is deliberate, since the only
  // way a user can currently stop being asked is to approve.
  const offerSiteBlock = isBrowserKind && !!request.browserOrigin;
  const handleBlockSite = useCallback(async () => {
    if (!current() || saving || !request.browserOrigin) return;
    setSaving(true); setSaveFailed(false);
    const saved = await useSettingsStore.getState().setBrowserSiteBlocked(request.browserOrigin, true);
    if (!current()) return;
    setSaving(false);
    if (saved) onCancel(); else setSaveFailed(true);
  }, [request.browserOrigin, current, saving, onCancel, setSaving, setSaveFailed]);

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
        {saveFailed && <p role="alert" className="px-6 pt-4 text-minor text-[var(--abu-danger)]">{t.settings.browserSaveFailed}</p>}

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
                {isUpload
                  ? uploadTitle
                  : request.kind === 'browser'
                    ? t.commandConfirm.browserTitle
                    : request.kind === 'self-extension'
                      ? t.commandConfirm.selfExtensionTitle
                      : t.commandConfirm[config.titleKey]}
              </h2>
              <p className="text-body text-[var(--abu-text-tertiary)] mt-0.5">
                {isUpload
                  ? t.commandConfirm.browserUploadDescription
                  : request.kind === 'browser'
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

          {isBrowserKind && request.browserPermissionTargets && <div className="mt-3 text-minor break-all text-[var(--abu-text-muted)]">{request.browserPermissionTargets.map((target, index) => <p key={index}>{target.origin}{target.embeddedIn ? ` (${format(t.settings.browserEmbeddedScope, { origin: target.embeddedIn })})` : ''}</p>)}</div>}

          {/* Which PAGE this is happening on. For an action aimed into a
              third-party region the command line above names the REGION, and
              without this the user would be approving something for a page the
              dialog never mentions. */}
          {isBrowserKind && !request.browserPermissionTargets
            && request.browserPageOrigin
            && request.browserPageOrigin !== request.browserOrigin && (
            <p className="mt-3 text-minor text-[var(--abu-text-tertiary)] leading-relaxed break-all">
              {format(t.commandConfirm.browserPageOrigin, { origin: request.browserPageOrigin })}
            </p>
          )}

          {/* The page's embedded regions — named before, not after, the click
              that would authorize them. Capped: what is not printed here is
              not granted, and the overflow says so rather than going quiet. */}
          {!request.browserPermissionTargets && embeddedOrigins.length > 0 && (
            <p className="mt-3 text-minor text-[var(--abu-text-tertiary)] leading-relaxed break-all">
              {format(t.commandConfirm.browserEmbeddedOrigins, { origins: embeddedOrigins.join('、') })}
              {unlistedEmbeddedCount > 0 && (
                <> {format(t.commandConfirm.browserEmbeddedOriginsMore, { count: unlistedEmbeddedCount })}</>
              )}
            </p>
          )}

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
              disabled={saving} onClick={onConfirm}
              className={`flex-1 h-10 text-body ${
                request.level === 'danger'
                  ? 'bg-[var(--abu-danger-solid)] hover:opacity-90'
                  : 'bg-[var(--abu-text-primary)] hover:bg-[var(--abu-text-secondary)]'
              } text-white`}
            >
              {isUpload
                ? (offerSiteGrant
                    ? t.commandConfirm.browserUploadConfirmOnce
                    : t.commandConfirm.browserUploadConfirm)
                : isBrowserKind ? t.settings.browserRequestOnce : t.commandConfirm.confirm}
            </Button>
          )}
          {!isBlocked && offerSiteGrant && (
            // The more consequential choice stays visually secondary: the
            // conversation-scoped button keeps the primary styling so the
            // safer default is the visually dominant one.
            <Button
              variant="outline"
              disabled={saving} onClick={() => void handleAlwaysAllowSite()}
              className="flex-1 h-10 text-body border-[var(--abu-border-hover)] hover:bg-[var(--abu-bg-muted)]"
              title={request.browserOrigin}
            >
              {alwaysAllowSiteLabel}
            </Button>
          )}
          </div>
          {offerSiteBlock && (
            // Second row, ghost styling: a standing block is consequential but
            // never the action we nudge toward, so it stays visually quiet
            // while remaining reachable without leaving the dialog.
            <Button
              variant="ghost"
              disabled={saving} onClick={() => void handleBlockSite()}
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
