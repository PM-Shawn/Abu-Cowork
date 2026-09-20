import { Building2, CircleAlert, LoaderCircle, LogOut, UserRound } from 'lucide-react';
import { IS_ENTERPRISE_BUILD, IS_PERSONAL_ACCOUNT_ENABLED } from '@/config/featureGates';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';

export type LoginPageStatus =
  | 'signed_out'
  | 'awaiting_browser'
  | 'exchanging'
  | 'expired';

export interface LoginPageProps {
  status: LoginPageStatus;
  error: string | null;
  hasAccount: boolean;
  onPersonalLogin: () => void;
  onEnterpriseLogin: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}

/** Map internal failure codes to short user-facing copy without echoing inputs. */
function failureMessage(
  error: string | null,
  copy: ReturnType<typeof useI18n>['t']['account'],
): string | null {
  if (!error) return null;
  if (error === 'cancelled') return copy.cancelled;
  if (error === 'timeout') return copy.timedOut;
  if (error === 'protocol_not_registered') return copy.protocolNotReady;
  if (error === 'protocol_status_unknown' || error === 'protocol_unavailable') {
    return copy.protocolStatusUnknown;
  }
  if (error === 'session_expired') return copy.sessionExpired;
  if (
    error === 'network_error' ||
    error === 'server_error' ||
    error === 'server_not_configured' ||
    error === 'invalid_server_url'
  ) return copy.serverUnavailable;
  return copy.loginFailed;
}

/** Presentational account entry panel; the dialog owns navigation and effects. */
export default function LoginPage({
  status,
  error,
  hasAccount,
  onPersonalLogin,
  onEnterpriseLogin,
  onCancel,
  onSignOut,
}: LoginPageProps) {
  const { t } = useI18n();
  const waiting = status === 'awaiting_browser' || status === 'exchanging';
  const failure = failureMessage(error, t.account);

  return (
    <section className="w-full px-6 pb-6 pt-2">
      {waiting ? (
        <div className="flex flex-col items-center gap-5 py-5 text-center">
          <LoaderCircle
            aria-hidden="true"
            className="h-7 w-7 animate-spin text-[var(--abu-clay)]"
            strokeWidth={1.8}
          />
          <p className="text-body text-[var(--abu-text-secondary)]">
            {status === 'exchanging' ? t.account.completingLogin : t.account.waitingBrowser}
          </p>
          <Button className="w-full" variant="subtle" onClick={onCancel}>
            {t.common.cancel}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {failure && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-xl bg-[var(--abu-danger-bg)] px-3 py-2.5 text-minor leading-relaxed text-[var(--abu-danger)]"
            >
              <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{failure}</span>
            </div>
          )}
          {IS_PERSONAL_ACCOUNT_ENABLED && (
            <Button className="w-full" size="lg" onClick={onPersonalLogin}>
              <UserRound aria-hidden="true" />
              {status === 'expired' ? t.account.retry : t.account.personalLogin}
            </Button>
          )}
          {IS_ENTERPRISE_BUILD && (
            <Button
              className="w-full"
              size="lg"
              // 个人登录还没开放时，企业登录是唯一入口，用主按钮样式。
              variant={IS_PERSONAL_ACCOUNT_ENABLED ? 'subtle' : 'default'}
              onClick={onEnterpriseLogin}
            >
              <Building2 aria-hidden="true" />
              {t.account.enterpriseLogin}
            </Button>
          )}
          {hasAccount && (
            <Button className="w-full" variant="subtle" onClick={onSignOut}>
              <LogOut aria-hidden="true" />
              {t.account.signOut}
            </Button>
          )}
          <p className="pt-2 text-center text-minor leading-relaxed text-[var(--abu-text-tertiary)]">
            {t.account.localWithoutLogin}
          </p>
        </div>
      )}
    </section>
  );
}
