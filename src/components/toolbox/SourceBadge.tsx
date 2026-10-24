import { Tag } from '@/components/ds/tag';
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
  // The pill stays short so the card's title keeps its room; which plugin it is
  // shows on hover and in the item's detail.
  const label = source.kind === 'plugin' ? t.toolbox.sourcePlugin : t.toolbox.sourceEnterprise;
  const title = source.kind === 'plugin' && source.plugin ? format(t.toolbox.sourceFromPlugin, { plugin: source.plugin }) : label;
  return (
    <span data-testid="source-badge" data-source-kind={source.kind} className={cn('inline-flex shrink-0', className)}>
      <Tag>
        <span title={title}>{label}</span>
      </Tag>
    </span>
  );
}
