import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';

/** Where an item on the 「我的」 shelf came from: the user's own work, an installed plugin, or the organization. */
export type ItemSource =
  | { kind: 'user' }
  /** `plugin` is the display name; absent while the owning record has not been read yet. */
  | { kind: 'plugin'; plugin?: string }
  | { kind: 'enterprise' };

/**
 * The provenance pill shared by skill, expert, team and plugin cards under
 * 「我的」. The user's own items carry no pill — that is the shelf's default and
 * a label there would be noise; a plugin's or the organization's items do,
 * because the same shelf also tells the user why those cannot be edited.
 */
export default function SourceBadge({ source, className }: { source: ItemSource; className?: string }) {
  const { t } = useI18n();
  if (source.kind === 'user') return null;
  const label = source.kind === 'plugin'
    ? (source.plugin ? format(t.toolbox.sourceFromPlugin, { plugin: source.plugin }) : t.toolbox.sourcePlugin)
    : t.toolbox.sourceEnterprise;
  return (
    <span
      data-testid="source-badge"
      data-source-kind={source.kind}
      title={label}
      className={cn('shrink-0 max-w-[12rem] truncate rounded px-1.5 py-0.5 text-caption font-medium bg-[var(--abu-bg-muted)] text-[var(--abu-text-muted)]', className)}
    >
      {label}
    </span>
  );
}
