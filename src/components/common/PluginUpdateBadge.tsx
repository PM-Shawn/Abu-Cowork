/**
 * The plugin-update count badge, shared by the two places that carry it: the
 * sidebar 「扩展」 entry (the only permanently visible entry point — a user who
 * never opens the market would otherwise never learn an update exists) and the
 * 插件 tab label inside that view.
 *
 * One component rather than two pieces of markup so the count cap, the status
 * tone and the accessible name cannot drift between them; the caller only
 * says which surface it is, for its test id.
 */

import { Tag } from '@/components/ds/tag';
import { format, useI18n } from '@/i18n';
import { usePluginStore } from '@/stores/pluginStore';

/** Above this the exact number stops being useful and starts widening the row. */
const MAX_SHOWN = 9;

export default function PluginUpdateBadge({ testId }: { testId: string }) {
  const { t } = useI18n();
  const count = usePluginStore((s) => s.updateAvailableCount);
  if (count <= 0) return null;
  return (
    // `role="status"` rather than a bare <span>: a generic element may not
    // carry an accessible name at all, so the aria-label below is free to be
    // dropped on one. It also makes the badge a polite live region, which is
    // what it is — the count changes on its own after a background rescan.
    <span
      data-testid={testId}
      role="status"
      aria-label={format(
        // English needs the singular; Chinese uses one form for both.
        count === 1 ? t.toolbox.pluginsUpdatesAvailableOne : t.toolbox.pluginsUpdatesAvailable,
        { count },
      )}
      className="inline-flex shrink-0"
    >
      <Tag tone="danger">{count > MAX_SHOWN ? `${MAX_SHOWN}+` : count}</Tag>
    </span>
  );
}
