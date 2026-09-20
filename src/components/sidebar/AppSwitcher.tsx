import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Compass, LogOut, Wand2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { GENERAL_APP_ID, type AppDefinition } from '@/types/app';
import { useAppStore, useAvailableApps, useSelectedApp } from '@/stores/appStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePluginAuthorStore } from '@/stores/pluginAuthorStore';
import { useToastStore } from '@/stores/toastStore';
import { useEnterpriseAppPolicy } from '@/core/enterprise/appPolicy';
import AppLogo from '@/components/app/AppLogo';

/**
 * The app switcher at the top of the sidebar (product spec §5.1): collapsed,
 * the current app; expanded, 通用 / 最近使用 / 我的应用 / 发现应用 / 创建应用.
 * Entering an app is one click on its row; the current row carries 退出.
 *
 * An organization can keep its employees inside the app it provides
 * (`useEnterpriseAppPolicy`): the general shell and 退出 then leave the menu,
 * while the organization's other apps stay switchable.
 */
export default function AppSwitcher({ className }: { className?: string }) {
  const { t } = useI18n();
  const apps = useAvailableApps();
  const selected = useSelectedApp();
  const { allowExit } = useEnterpriseAppPolicy();
  const recentAppIds = useAppStore((s) => s.recentAppIds);
  const enterApp = useAppStore((s) => s.enterApp);
  const exitApp = useAppStore((s) => s.exitApp);
  const openExtensions = useSettingsStore((s) => s.openExtensions);
  const addToast = useToastStore((s) => s.addToast);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const installed = apps.filter((app) => app.appId !== GENERAL_APP_ID);
  const recent = recentAppIds.map((id) => installed.find((app) => app.appId === id)).filter((app): app is AppDefinition => app !== undefined);
  const rest = installed.filter((app) => !recentAppIds.includes(app.appId));
  const isGeneral = selected.appId === GENERAL_APP_ID;

  const enter = (appId: string) => {
    setOpen(false);
    if (appId === selected.appId) return;
    enterApp(appId);
  };
  const createApp = () => {
    setOpen(false);
    void usePluginAuthorStore.getState().create('app').catch((error) => addToast({ type: 'error', title: t.toolbox.plugins, message: String(error) }));
  };

  const row = (app: AppDefinition, current: boolean) => (
    <div
      key={app.appId}
      role="menuitem"
      tabIndex={0}
      data-testid={`app-switcher-item-${app.appId}`}
      aria-current={current ? 'true' : undefined}
      onClick={() => enter(app.appId)}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); enter(app.appId); } }}
      className={cn('flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left', current ? 'bg-[var(--abu-bg-hover)]' : 'hover:bg-[var(--abu-bg-hover)]')}
    >
      <AppLogo name={app.name} logo={app.logo} logoDark={app.logoDark} general={app.appId === GENERAL_APP_ID} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-[var(--abu-text-primary)]">{app.name}</span>
        {app.description && <span className="block truncate text-caption text-[var(--abu-text-tertiary)]">{app.description}</span>}
      </span>
      {current && app.appId !== GENERAL_APP_ID && allowExit && (
        <button
          type="button"
          data-testid="app-switcher-exit"
          className="btn-ghost inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-caption text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
          onClick={(event) => { event.stopPropagation(); setOpen(false); exitApp(); }}
        >
          <LogOut className="h-3 w-3" />
          {t.appSwitcher.exit}
        </button>
      )}
    </div>
  );
  const heading = (label: string) => <div className="px-2 pt-2 pb-1 text-caption font-medium text-[var(--abu-text-tertiary)]">{label}</div>;

  return (
    <div ref={root} className={cn('relative', className)} data-testid="app-switcher">
      <button
        type="button"
        data-testid="app-switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.appSwitcher.openLabel}
        onClick={() => setOpen((value) => !value)}
        className="btn-ghost flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--abu-bg-hover)]"
      >
        <AppLogo name={selected.name} logo={selected.logo} logoDark={selected.logoDark} general={isGeneral} size="md" />
        <span className="min-w-0 flex-1 truncate text-h-xs text-[var(--abu-text-primary)]" data-testid="app-switcher-current">{selected.name}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-[var(--abu-text-tertiary)] transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div role="menu" data-testid="app-switcher-menu" className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)] p-1.5 shadow-lg">
          {(allowExit || isGeneral) && row(apps[0], isGeneral)}
          {recent.length > 0 && (<>{heading(t.appSwitcher.recent)}{recent.map((app) => row(app, app.appId === selected.appId))}</>)}
          {rest.length > 0 && (<>{heading(t.appSwitcher.mine)}{rest.map((app) => row(app, app.appId === selected.appId))}</>)}
          <div className="mt-1 border-t border-[var(--abu-border)] pt-1">
            <button
              type="button"
              role="menuitem"
              data-testid="app-switcher-discover"
              onClick={() => { setOpen(false); openExtensions('plugins', 'market', 'apps'); }}
              className="btn-ghost flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-body text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
            >
              <Compass className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
              {t.appSwitcher.discover}
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="app-switcher-create"
              onClick={createApp}
              className="btn-ghost flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-body text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
            >
              <Wand2 className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
              {t.appSwitcher.create}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
