import { useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { GENERAL_APP_ID, type AppDefinition } from '@/types/app';
import { useAppStore, useAvailableApps, useSelectedApp } from '@/stores/appStore';
import { usePluginAuthorStore } from '@/stores/pluginAuthorStore';
import { useToastStore } from '@/stores/toastStore';
import { useEnterpriseAppPolicy } from '@/core/enterprise/appPolicy';
import AppLogo from '@/components/app/AppLogo';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '@/components/ds/menu';

/**
 * The app switcher, beside Abu's own name in the sidebar's brand row (product
 * spec §5.1). The button reads 发现应用 in the general shell and carries the
 * app's logo and name inside an app; the menu lists 通用 / 最近使用 / 我的应用
 * and ends with 查看更多 (the app market) and 创建应用. Switching is one click
 * on a row, 通用 included — that row is how a user leaves an app.
 *
 * Apps and plugins stay apart: 查看更多 opens the app market, which lists only
 * apps, and the plugin market lists only plugins.
 *
 * An organization can keep its employees inside the app it provides
 * (`useEnterpriseAppPolicy`): the 通用 row then leaves the menu, while the
 * organization's other apps stay switchable.
 */
export default function AppSwitcher({ className }: { className?: string }) {
  const { t } = useI18n();
  const apps = useAvailableApps();
  const selected = useSelectedApp();
  const { allowExit } = useEnterpriseAppPolicy();
  const recentAppIds = useAppStore((s) => s.recentAppIds);
  const enterApp = useAppStore((s) => s.enterApp);
  const addToast = useToastStore((s) => s.addToast);
  const setAppMarketOpen = useAppStore((s) => s.setAppMarketOpen);
  const [open, setOpen] = useState(false);
  // 查看更多 and 创建应用 open dialogs of their own; they start once the menu has gone.
  const afterMenuClose = useRef<(() => void) | null>(null);

  const installed = apps.filter((app) => app.appId !== GENERAL_APP_ID);
  const recent = recentAppIds.map((id) => installed.find((app) => app.appId === id)).filter((app): app is AppDefinition => app !== undefined);
  const rest = installed.filter((app) => !recentAppIds.includes(app.appId));
  const isGeneral = selected.appId === GENERAL_APP_ID;

  const enter = (appId: string) => {
    if (appId === selected.appId) return;
    enterApp(appId);
  };
  const createApp = () => {
    void usePluginAuthorStore.getState().create('app').catch((error) => addToast({ type: 'error', title: t.toolbox.plugins, message: String(error) }));
  };

  // An app row carries a logo, a name and a one-line description. The rows are one
  // radio group, so the current app is checked (aria-checked); the others show 进入
  // while highlighted.
  const row = (app: AppDefinition, current: boolean) => (
    <MenuRadioItem key={app.appId} value={app.appId}>
      <span data-testid={`app-switcher-item-${app.appId}`} className="flex items-center gap-2">
        <AppLogo name={app.name} logo={app.logo} logoDark={app.logoDark} general={app.appId === GENERAL_APP_ID} size="sm" />
        <span className="min-w-0 flex-1 truncate">
          {app.name}
          {app.description && <span className="ml-2 text-ui-sm text-label-tertiary">{app.description}</span>}
        </span>
        {!current && (
          <span
            data-testid={`app-switcher-enter-${app.appId}`}
            aria-hidden="true"
            className="hidden shrink-0 text-ui-sm text-label-tertiary in-data-highlighted:inline"
          >
            {t.appSwitcher.enter}
          </span>
        )}
      </span>
    </MenuRadioItem>
  );

  return (
    <div className={cn('relative', className)} data-testid="app-switcher">
      <Menu
        open={open}
        onOpenChange={setOpen}
        onCloseAutoFocus={(event) => {
          const action = afterMenuClose.current;
          if (!action) return;
          afterMenuClose.current = null;
          // These open legacy dialogs that take no focus themselves; keeping focus off
          // the trigger stops Enter or Space from reopening the menu underneath them.
          event.preventDefault();
          action();
        }}
        trigger={
          <Button
            size="sm"
            data-testid="app-switcher-trigger"
            aria-label={t.appSwitcher.openLabel}
            className="w-full justify-start"
          >
            {isGeneral
              ? <Icon icon={AppIcons.discoverApps} size="sm" className="text-label-secondary" />
              : <AppLogo name={selected.name} logo={selected.logo} logoDark={selected.logoDark} size="sm" />}
            <span
              className={cn('min-w-0 flex-1 text-left', isGeneral ? 'whitespace-nowrap' : 'truncate')}
              data-testid="app-switcher-current"
            >
              {isGeneral ? t.appSwitcher.discover : selected.name}
            </span>
            <Icon icon={AppIcons.expand} size="sm" className="text-label-tertiary" />
          </Button>
        }
      >
        <div data-testid="app-switcher-menu" className="w-60">
          {/* A long app list scrolls inside the menu instead of running off the window. */}
          <div className="max-h-96 overflow-y-auto">
            <MenuRadioGroup value={selected.appId} onValueChange={enter}>
              {!isGeneral && allowExit && row(apps[0], false)}
              {recent.length > 0 && (<><MenuLabel>{t.appSwitcher.recent}</MenuLabel>{recent.map((app) => row(app, app.appId === selected.appId))}</>)}
              {rest.length > 0 && (<><MenuLabel>{t.appSwitcher.mine}</MenuLabel>{rest.map((app) => row(app, app.appId === selected.appId))}</>)}
            </MenuRadioGroup>
          </div>
          <MenuSeparator />
          <MenuItem icon={AppIcons.appMarket} onSelect={() => { afterMenuClose.current = () => setAppMarketOpen(true); }}>
            <span data-testid="app-switcher-discover">{t.appSwitcher.viewMore}</span>
          </MenuItem>
          <MenuItem icon={AppIcons.createApp} onSelect={() => { afterMenuClose.current = createApp; }}>
            <span data-testid="app-switcher-create">{t.appSwitcher.create}</span>
          </MenuItem>
        </div>
      </Menu>
    </div>
  );
}
