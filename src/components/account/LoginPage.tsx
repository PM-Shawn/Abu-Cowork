import { IS_ENTERPRISE_BUILD } from '@/config/featureGates';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Spinner } from '@/components/ds/spinner';
import { useI18n } from '@/i18n';

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
    <section className="w-full">
      {waiting ? (
        <div className="flex flex-col items-center gap-5 py-5 text-center">
          {/* One box for both sentences, so Cancel stays where it is when one follows the other. */}
          <div className="flex h-14 flex-col items-center justify-center gap-3">
            {status === 'exchanging' ? (
              <Spinner label={t.account.completingLogin} />
            ) : (
              // Waiting for the user to act in the browser: a still icon, nothing spins.
              <>
                <Icon icon={AppIcons.loading} size="lg" className="text-label-secondary" />
                <p className="text-ui text-label-secondary">{t.account.waitingBrowser}</p>
              </>
            )}
          </div>
          <div className="w-full">
            <Button className="w-full" variant="secondary" onClick={onCancel}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {failure && <InlineMessage tone="danger">{failure}</InlineMessage>}
          <div>
            <Button className="w-full" variant="primary" icon={AppIcons.account} onClick={onPersonalLogin}>
              {status === 'expired' ? t.account.retry : t.account.personalLogin}
            </Button>
          </div>
          {IS_ENTERPRISE_BUILD && (
            <div>
              <Button className="w-full" variant="secondary" icon={AppIcons.enterprise} onClick={onEnterpriseLogin}>
                {t.account.enterpriseLogin}
              </Button>
            </div>
          )}
          {hasAccount && (
            <div>
              <Button className="w-full" variant="secondary" icon={AppIcons.signOut} onClick={onSignOut}>
                {t.account.signOut}
              </Button>
            </div>
          )}
          <p className="pt-2 text-center text-ui-sm text-label-tertiary">
            {t.account.localWithoutLogin}
          </p>
        </div>
      )}
    </section>
  );
}
