/**
 * What Abu knows about one installed plugin, in two sizes.
 *
 * `InstalledPluginSummary` is the one-line form the 「我的」 list rows use.
 * `InstalledPluginDetail` (default) is the 「管理」 dialog the market row opens,
 * which is the only place the market surface can answer "what did this
 * actually bring in, and where did it come from?" now that installed items are
 * shown in place rather than in a separate 已安装 tab.
 *
 * Both read the install *record* — the same list the uninstaller withdraws
 * from — never a rescan of the package directory, so what the UI says a plugin
 * contributed stays identical to what removal takes back out.
 *
 * The dialog is read-only apart from uninstall: it reports, it does not
 * reconfigure. The uninstall button only *asks* — the confirmation and the
 * store call belong to {@link UninstallPluginDialog}.
 */

import { createPortal } from 'react-dom';
import { useEffect } from 'react';
import { Bot, Server, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { Button } from '@/components/ui/button';
import type { InstalledPlugin } from '@/core/plugin/installedStore';

/** "来自 X · N 个技能 · M 个连接器" — the row subtitle in the 「我的」 list. */
export function InstalledPluginSummary({ plugin }: { plugin: InstalledPlugin }) {
  const { t } = useI18n();
  const tb = t.toolbox;
  return (
    <p className="mt-0.5 truncate text-minor text-[var(--abu-text-tertiary)]">
      {format(tb.pluginsFromMarketplace, { name: plugin.marketplace })}
      {' · '}
      {format(tb.pluginsSkillCount, { count: plugin.contributed.skills.length })}
      {' · '}
      {format(tb.pluginsServerCount, { count: plugin.contributed.mcpServers.length })}
    </p>
  );
}

function Section({
  icon: Icon,
  title,
  items,
  emptyLabel,
}: {
  icon: typeof Sparkles;
  title: string;
  items: string[];
  emptyLabel: string;
}) {
  return (
    <section className="space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-h-xs text-[var(--abu-text-primary)]">
        <Icon className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
        {title}
      </h4>
      {items.length === 0 ? (
        <p className="text-body text-[var(--abu-text-muted)]">{emptyLabel}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li
              key={item}
              className="rounded bg-[var(--abu-bg-muted)] px-2 py-1 text-body text-[var(--abu-text-secondary)]"
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface InstalledPluginDetailProps {
  /** The install to describe; `null` closes the dialog. */
  plugin: InstalledPlugin | null;
  onClose: () => void;
  /** Hand the record to the shared uninstall confirmation. */
  onUninstall: (plugin: InstalledPlugin) => void;
}

export default function InstalledPluginDetail({
  plugin,
  onClose,
  onUninstall,
}: InstalledPluginDetailProps) {
  const { t } = useI18n();
  useEffect(() => {
    if (!plugin) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [plugin, onClose]);

  if (!plugin) return null;
  const tb = t.toolbox;
  // A verified remote install pins one of these; a local one pins neither.
  const pinned = plugin.sha ?? plugin.checksum;

  return createPortal(
    <div
      data-electron-no-drag
      data-testid="plugin-manage-dialog"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-6 animate-in fade-in duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tb.pluginsManageTitle}
        className="flex max-h-[80vh] w-[520px] flex-col rounded-2xl bg-[var(--abu-bg-base)] shadow-xl animate-in zoom-in-95 duration-150"
      >
        <h3 className="shrink-0 px-6 pt-6 text-h-sm text-[var(--abu-text-primary)]">
          {tb.pluginsManageTitle}
        </h3>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="truncate text-h-xs text-[var(--abu-text-primary)]">
                {plugin.name}
              </span>
              <span className="shrink-0 text-caption text-[var(--abu-text-muted)]">
                v{plugin.version}
              </span>
            </div>
            <p className="mt-0.5 text-minor text-[var(--abu-text-tertiary)]">
              {format(tb.pluginsFromMarketplace, { name: plugin.marketplace })}
            </p>
          </div>

          <Section
            icon={Sparkles}
            title={tb.pluginsDisclosureSkills}
            items={plugin.contributed.skills}
            emptyLabel={tb.pluginsDisclosureNone}
          />
          <Section
            icon={Server}
            title={tb.pluginsDisclosureServers}
            items={plugin.contributed.mcpServers}
            emptyLabel={tb.pluginsDisclosureNone}
          />
          {/* Named for the same reason as the other two: uninstall withdraws
              these, and they live outside the package directory. */}
          <Section
            icon={Bot}
            title={tb.pluginsDisclosureAgents}
            items={plugin.contributed.agents}
            emptyLabel={tb.pluginsDisclosureNone}
          />

          {pinned && (
            <section className="space-y-1.5">
              <h4 className="flex items-center gap-1.5 text-h-xs text-[var(--abu-text-primary)]">
                <ShieldCheck className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                {tb.pluginsDisclosureSource}
              </h4>
              <p className="break-all font-mono text-minor text-[var(--abu-text-muted)]">
                {pinned}
              </p>
            </section>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 px-6 pb-6">
          <Button
            variant="ghost"
            data-testid="plugin-manage-uninstall"
            aria-label={`${tb.pluginsUninstall}: ${plugin.name}`}
            onClick={() => onUninstall(plugin)}
          >
            <Trash2 className="h-3.5 w-3.5 text-[var(--abu-danger)]" />
            <span className="text-[var(--abu-danger)]">{tb.pluginsUninstall}</span>
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t.common.close}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
