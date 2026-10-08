/** Shared installed-plugin detail, activation and authoring actions.
 * Contents come from the installed record; source details replace the body
 * without resizing the dialog. Uninstall requires its own confirmation.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Server, Sparkles, Package, MessageCircle, ArrowLeft } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import InstalledItemMenu, { type InstalledItemMenuAction } from '@/components/toolbox/InstalledItemMenu';
import { Toggle } from '@/components/ui/toggle';
import { usePluginActivation } from './usePluginActivation';
import { useTrialLauncher } from '@/components/toolbox/useTrialLauncher';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/button';
import type { InstalledPlugin } from '@/core/plugin/installedStore';

/** "来自 X · N 个技能 · M 个连接器" — the row subtitle in the 「我的」 list. */
export function InstalledPluginSummary({ plugin }: { plugin: InstalledPlugin }) {
  const { t } = useI18n();
  const tb = t.toolbox;
  return (
    <span className="mt-0.5 block truncate text-minor text-[var(--abu-text-tertiary)]">
      {plugin.authoringId ? tb.pluginsAuthoredSource : format(tb.pluginsFromMarketplace, { name: plugin.marketplace })}
      {' · '}
      {format(tb.pluginsSkillCount, { count: plugin.contributed.skills.length })}
      {' · '}
      {format(tb.pluginsServerCount, { count: plugin.contributed.mcpServers.length })}
    </span>
  );
}

function Section({ icon: Icon, title, items = [] }: {
  icon: typeof Sparkles;
  title: string;
  items?: string[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h4 className="text-minor font-medium text-[var(--abu-text-muted)]">{title}</h4>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {items.map(item => (
          <li key={item} className="flex items-center gap-3 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] px-3 py-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--abu-bg-active)]">
              <Icon className="h-4 w-4 text-[var(--abu-text-muted)]" />
            </span>
            <span className="min-w-0 break-words text-body font-medium text-[var(--abu-text-primary)]">{item}</span>
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
}

export default function InstalledPluginDetail({
  plugin,
  authorActions,
  authorUpdate,
  home,
  description,
  onClose,
  onUninstall,
}: InstalledPluginDetailProps) {
  const { t } = useI18n();
  const [showSource, setShowSource] = useState(false);
  useEffect(() => setShowSource(false), [plugin?.key]);
  const activation = usePluginActivation(plugin, home);
  const launchTrial = useTrialLauncher();
  const addToast = useToastStore(s => s.addToast);

  if (!plugin) return null;
  const tb = t.toolbox;
  // A verified remote install pins one of these; a local one pins neither.
  const pinned = plugin.sha ?? plugin.checksum;

  return createPortal(
    <ToolDetailModal
      open
      onClose={onClose}
      stackedHeader
      maxWidth="max-w-2xl"
      panelClassName="h-[min(640px,85vh)]"
      avatar={showSource ? <button type="button" aria-label={tb.backToDetails} title={tb.backToDetails} onClick={() => setShowSource(false)} className="flex h-full w-full items-center justify-center rounded-full hover:bg-[var(--abu-bg-active)]"><ArrowLeft className="h-5 w-5 text-[var(--abu-text-muted)]" /></button> : <Package className="h-6 w-6 text-[var(--abu-text-muted)]" />}
      headerActions={showSource ? undefined : <>

        <Toggle checked={activation.enabled} disabled={activation.busy || !activation.available} tone="green" onChange={() => {
        void activation.toggle().catch(error => addToast({ type: 'error', title: plugin.name, message: String(error) }));
      }} />
        <InstalledItemMenu testId="plugin-detail-menu" ariaLabel={format(tb.itemMenuLabel, { name: plugin.name })} actions={[
          ...(authorActions ?? []),
          { id: 'view', label: tb.pluginsDisclosureSource, onSelect: () => setShowSource(true) },
        ]} />
      </>}
      footer={showSource ? undefined : <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" className="bg-[var(--abu-danger-bg)] text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)] hover:text-[var(--abu-danger)] rounded-xl" onClick={() => onUninstall(plugin)}>{tb.pluginsUninstall}</Button>
        <div className="flex items-center gap-3">
        {authorUpdate && <Button variant="ghost" size="sm" className="rounded-xl border border-[var(--abu-border)]" onClick={authorUpdate.onReview}>{authorUpdate.available ? tb.pluginsPreviewUpdate : tb.pluginsCheckChanges}</Button>}
        <Button size="sm" className="rounded-xl" disabled={!activation.enabled || activation.busy} onClick={() => { onClose(); launchTrial({ name: plugin.name, description }); }}><MessageCircle className="h-3.5 w-3.5" />{tb.menuTrial}</Button>
        </div>
      </div>}
    >
      {showSource ? <div data-testid="plugin-source-dialog" className="space-y-4">
        <h2 className="text-h-lg font-semibold text-[var(--abu-text-primary)]">{tb.pluginsDisclosureSource}</h2>
        <p className="text-body text-[var(--abu-text-primary)]">{plugin.authoringId ? tb.pluginsAuthoredSource : format(tb.pluginsFromMarketplace, { name: plugin.marketplace })} · v{plugin.version}</p>
        {pinned && <p className="break-all font-mono text-minor text-[var(--abu-text-muted)]">{pinned}</p>}
      </div> : <div data-testid="plugin-manage-dialog">
        <div className="space-y-4">
          <div className="space-y-2">
            <h2 className="text-h-lg font-semibold text-[var(--abu-text-primary)]">{plugin.name} <span className="font-normal text-[var(--abu-text-muted)]">{tb.plugins}</span></h2>
            {authorUpdate && <p className="text-minor text-[var(--abu-text-muted)]">{authorUpdate.available ? tb.pluginsAuthorUpdateAvailable : tb.pluginsAuthorUpdateHint}</p>}
            {description && <p className="text-body text-[var(--abu-text-secondary)] leading-relaxed">{description}</p>}
          </div>
          <div className="space-y-5">
          <Section
            icon={Sparkles}
            title={tb.skills}
            items={plugin.contributed.skills}
          />
          <Section
            icon={Server}
            title={tb.connectors}
            items={plugin.contributed.mcpServers}
          />
          {/* Named for the same reason as the other two: uninstall withdraws
              these, and they live outside the package directory. */}
          <Section
            icon={Bot}
            title={tb.pluginsDisclosureAgents}
            items={plugin.contributed.agents}
          />

          </div>


        </div>

      </div>}
    </ToolDetailModal>,
    document.body,
  );
}
