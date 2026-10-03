/** Shared installed-plugin detail, activation and authoring actions.
 * Contents come from the installed record; source details replace the body
 * without resizing the dialog. Uninstall requires its own confirmation.
 */

import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { useI18n, format } from '@/i18n';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import InstalledItemMenu, { type InstalledItemMenuAction } from '@/components/toolbox/InstalledItemMenu';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import { cn } from '@/lib/utils';
import { usePluginActivation } from './usePluginActivation';
import { PLUGIN_WINDOW_CONTENT_HEIGHT } from './windowHeight';
import { useTrialLauncher } from '@/components/toolbox/useTrialLauncher';
import { useToastStore } from '@/stores/toastStore';
import { useAppStore } from '@/stores/appStore';
import { useTeamStore } from '@/stores/teamStore';
import { agentRegistry } from '@/core/agent/registry';
import { effectiveRun, resolveText, runExpertName, runTeamId } from '@/core/app/appBinding';
import type { AppScene } from '@/types/app';
import type { InstalledPlugin } from '@/core/plugin/installedStore';

/** "来自 X · N 个技能 · M 个连接器" — the row subtitle in the 「我的」 list. */
export function InstalledPluginSummary({ plugin }: { plugin: InstalledPlugin }) {
  const { t } = useI18n();
  const tb = t.toolbox;
  return (
    <span className="block truncate text-ui-sm text-label-tertiary">
      {plugin.authoringId ? tb.pluginsAuthoredSource : format(tb.pluginsFromMarketplace, { name: plugin.marketplace })}
      {' · '}
      {format(tb.pluginsSkillCount, { count: plugin.contributed.skills.length })}
      {' · '}
      {format(tb.pluginsServerCount, { count: plugin.contributed.mcpServers.length })}
    </span>
  );
}

/**
 * "这个应用里有什么" (product spec §5.2): the app's modes and scenes with
 * whoever runs each one, read from the installed app the plugin provides. The
 * skills and connectors above already name the rest of the package.
 */
function AppContents({ pluginKey }: { pluginKey: string }) {
  const { t, format, locale } = useI18n();
  const app = useAppStore((s) => s.installedApps.find((item) => item.pluginKey === pluginKey));
  const teams = useTeamStore((s) => s.teams);
  if (!app) return null;

  const owner = (scene: AppScene): string => {
    const run = effectiveRun(app, scene);
    if (!run) return t.appHome.sceneRunDefault;
    if ('team' in run) {
      const team = teams.find((item) => item.id === runTeamId(app, run));
      return format(t.appHome.sceneRunTeam, { name: team?.name ?? run.team });
    }
    if ('expert' in run) {
      const name = runExpertName(run)!;
      return format(t.appHome.sceneRunExpert, { name: agentRegistry.getAgent(name)?.displayNames?.[locale] ?? name });
    }
    return format(t.appHome.sceneRunSkill, { name: run.skill });
  };

  return (
    <section className="space-y-2" data-testid="plugin-detail-app">
      <h4 className="text-ui-sm font-medium text-label-tertiary">{t.toolbox.pluginsAppContents}</h4>
      <div className="space-y-2">
        {app.config.home.modes.items.map((mode) => (
          <div key={mode.modeId} className="rounded-panel border border-separator px-3 py-2">
            <p className="text-ui font-medium text-label">{resolveText(mode.title)}</p>
            <ul className="mt-1 space-y-1">
              {mode.scenes.map((scene) => (
                <li key={scene.id} className="flex items-baseline justify-between gap-3 text-ui-sm">
                  <span className="truncate text-label-secondary">{resolveText(scene.title)}</span>
                  <span className="shrink-0 text-label-tertiary">{owner(scene)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function Section({ icon, title, items = [] }: {
  /** A design-system icon: callers pass `AppIcons.*`. */
  icon: ComponentProps<typeof Icon>['icon'];
  title: string;
  items?: string[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h4 className="text-ui-sm font-medium text-label-tertiary">{title}</h4>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {items.map(item => (
          <li key={item} className="flex items-center gap-3 rounded-panel border border-separator px-3 py-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-fill">
              <Icon icon={icon} size="md" className="text-label-tertiary" />
            </span>
            <span className="min-w-0 break-words text-ui font-medium text-label">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface InstalledPluginDetailProps {
  authorActions?: InstalledItemMenuAction[];
  authorUpdate?: { available: boolean; onReview: () => void };
  home: string;
  description?: string;
  /** The install to describe; `null` closes the dialog. */
  plugin: InstalledPlugin | null;
  onClose: () => void;
  /** Hand the record to the shared uninstall confirmation. */
  onUninstall: (plugin: InstalledPlugin) => void;
  /** Runs once the window has gone; `event.preventDefault()` there keeps the focus from returning to the card that opened it. */
  onCloseAutoFocus?: (event: Event) => void;
}

export default function InstalledPluginDetail({
  plugin,
  authorActions,
  authorUpdate,
  home,
  description,
  onClose,
  onUninstall,
  onCloseAutoFocus,
}: InstalledPluginDetailProps) {
  const { t } = useI18n();
  const [showSource, setShowSource] = useState(false);
  // The source page takes the place of the details: the focus goes to its way back when it
  // opens, and to the menu that opened it when it is left.
  const moveFocus = useRef(false);
  const backRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [shownKey, setShownKey] = useState(plugin?.key);
  if (shownKey !== plugin?.key) {
    // Another plugin (or none): its window opens on the details.
    setShownKey(plugin?.key);
    setShowSource(false);
  }
  useLayoutEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    if (showSource) backRef.current?.focus();
    else actionsRef.current?.querySelector<HTMLElement>('[data-testid="plugin-detail-menu"]')?.focus();
  }, [showSource]);
  const activation = usePluginActivation(plugin, home);
  const launchTrial = useTrialLauncher();
  const addToast = useToastStore(s => s.addToast);

  if (!plugin) return null;
  const tb = t.toolbox;
  // A verified remote install pins one of these; a local one pins neither.
  const pinned = plugin.sha ?? plugin.checksum;
  const openSource = (open: boolean) => { moveFocus.current = true; setShowSource(open); };

  return (
    <ToolDetailModal
      open
      // The window's name is the plugin's: the heading inside adds the word for what it is.
      ariaLabel={plugin.name}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
      stackedHeader
      maxWidth="max-w-2xl"
      panelClassName={PLUGIN_WINDOW_CONTENT_HEIGHT}
      avatar={showSource
        ? <IconButton ref={backRef} icon={AppIcons.back} label={tb.backToDetails} onClick={() => openSource(false)} />
        : <Icon icon={AppIcons.bundle} size="lg" className="text-label-tertiary" />}
      headerActions={showSource ? undefined : <div ref={actionsRef} className="flex items-center gap-2">
        {/* Dimmed while the plugin is being turned on; it stays enabled so the keyboard focus stays on it. */}
        <span className={cn('flex', activation.busy && 'opacity-40')}>
          <Switch checked={activation.enabled} disabled={!activation.available} aria-label={plugin.name} onCheckedChange={() => {
            void activation.toggle().catch(error => addToast({ type: 'error', title: plugin.name, message: String(error) }));
          }} />
        </span>
        <InstalledItemMenu testId="plugin-detail-menu" ariaLabel={format(tb.itemMenuLabel, { name: plugin.name })} actions={[
          ...(authorActions ?? []),
          { id: 'view', label: tb.pluginsDisclosureSource, onSelect: () => openSource(true) },
        ]} />
      </div>}
      // The row is as tall as the footer of the draft window and of the preview, so the three windows are one size.
      footer={showSource ? undefined : <div className="flex min-h-7 w-full items-center justify-between gap-3">
        <Button variant="danger" size="sm" icon={AppIcons.delete} onClick={() => onUninstall(plugin)}>{tb.pluginsUninstall}</Button>
        <div className="flex items-center gap-2">
          {authorUpdate && <Button variant="secondary" size="sm" onClick={authorUpdate.onReview}>{authorUpdate.available ? tb.pluginsPreviewUpdate : tb.pluginsCheckChanges}</Button>}
          <Button variant="primary" size="sm" icon={AppIcons.startChat} disabled={!activation.enabled || activation.busy} onClick={() => { onClose(); launchTrial({ name: plugin.name, description }); }}>{tb.menuTrial}</Button>
        </div>
      </div>}
    >
      {showSource ? <div data-testid="plugin-source-dialog" className="space-y-4">
        <h2 className="text-title text-label">{tb.pluginsDisclosureSource}</h2>
        <p className="text-ui text-label">{plugin.authoringId ? tb.pluginsAuthoredSource : format(tb.pluginsFromMarketplace, { name: plugin.marketplace })} · v{plugin.version}</p>
        {pinned && <p className="break-all font-code text-ui-sm text-label-tertiary">{pinned}</p>}
      </div> : <div data-testid="plugin-manage-dialog" className="space-y-4">
        <div className="space-y-2">
          <h2 className="text-title text-label">{plugin.name} <span className="font-normal text-label-tertiary">{tb.plugins}</span></h2>
          {authorUpdate && (authorUpdate.available
            ? <p><Tag tone="info">{tb.pluginsAuthorUpdateAvailable}</Tag></p>
            : <p className="text-ui-sm text-label-tertiary">{tb.pluginsAuthorUpdateHint}</p>)}
          {description && <p className="text-ui text-label-secondary">{description}</p>}
        </div>
        <div className="space-y-5">
          <Section
            icon={AppIcons.sparkles}
            title={tb.skills}
            items={plugin.contributed.skills}
          />
          <Section
            icon={AppIcons.connector}
            title={tb.connectors}
            items={plugin.contributed.mcpServers}
          />
          {/* Named for the same reason as the other two: uninstall withdraws
              these, and they live outside the package directory. */}
          <Section
            icon={AppIcons.agent}
            title={tb.pluginsDisclosureAgents}
            items={plugin.contributed.agents}
          />
          <AppContents pluginKey={plugin.key} />
        </div>
      </div>}
    </ToolDetailModal>
  );
}
