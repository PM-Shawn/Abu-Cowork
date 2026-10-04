import { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useAccountStore } from '@/core/account/accountStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { isMacOS } from '@/utils/platform';
import { cn } from '@/lib/utils';
import { startEnterpriseAccountLogin } from '@/core/enterprise/accountLogin';
import LoginPage, { type LoginPageStatus } from './LoginPage';

/** Centered account entry dialog shared by the sidebar and account settings. */
export default function AccountLoginDialog() {
  const open = useSettingsStore((state) => state.accountLoginOpen);
  const close = useSettingsStore((state) => state.closeAccountLogin);
  const openSystemSettings = useSettingsStore((state) => state.openSystemSettings);
  const status = useAccountStore((state) => state.status);
  const account = useAccountStore((state) => state.account);
  const error = useAccountStore((state) => state.error);
  const startPersonalLogin = useAccountStore((state) => state.startPersonalLogin);
  const cancel = useAccountStore((state) => state.cancel);
  const signOut = useAccountStore((state) => state.signOut);
  const { t } = useI18n();
  const personalStartRequested = useRef(false);

  const cancelAttempt = useCallback(() => {
    personalStartRequested.current = false;
    cancel();
  }, [cancel]);

  const closeDialog = useCallback(() => {
    if (
      personalStartRequested.current ||
      status === 'awaiting_browser' ||
      status === 'exchanging'
    ) cancelAttempt();
    close();
  }, [cancelAttempt, close, status]);

  useEffect(() => {
    if (open && status === 'signed_in') {
      personalStartRequested.current = false;
      close();
    }
  }, [close, open, status]);

  useEffect(() => {
    if (!open) {
      personalStartRequested.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (error) personalStartRequested.current = false;
  }, [error]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDialog();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeDialog, open]);

  if (!open || status === 'signed_in') return null;

  const pageStatus: LoginPageStatus = status;

  return (
    <div
      data-abu-account-dialog
      data-electron-no-drag
      className={cn(
        'fixed inset-0 z-[110] flex items-center justify-center bg-black/32 p-6 backdrop-blur-[2px]',
        isMacOS() && 'pt-12',
      )}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="abu-account-dialog-title"
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)] shadow-2xl"
      >
        <button
          data-abu-account-dialog-close
          onClick={closeDialog}
          aria-label={t.common.close}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-[var(--abu-text-tertiary)] transition-colors hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]"
        >
          <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
        <header className="px-6 pb-3 pt-6 text-center">
          <h2 id="abu-account-dialog-title" className="text-h-sm font-semibold text-[var(--abu-text-primary)]">
            {t.account.loginRegister}
          </h2>
        </header>
        <LoginPage
          status={pageStatus}
          error={error}
          hasAccount={account !== null}
          onPersonalLogin={() => {
            personalStartRequested.current = true;
            void startPersonalLogin();
          }}
          onEnterpriseLogin={() => {
            if (personalStartRequested.current) cancelAttempt();
            close();
            void startEnterpriseAccountLogin()
              .then((result) => {
                if (result === 'configuration_required') openSystemSettings('enterprise');
              })
              .catch(() => openSystemSettings('enterprise'));
          }}
          onCancel={cancelAttempt}
          onSignOut={() => void signOut()}
        />
      </div>
    </div>
  );
}
