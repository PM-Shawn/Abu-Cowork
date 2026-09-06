/**
 * The plugin-update count badge, shared by the two places that carry it: the
 * sidebar 「扩展」 entry (the only permanently visible entry point — a user who
 * never opens the market would otherwise never learn an update exists) and the
 * 插件 tab label inside that view.
 *
 * One component rather than two pieces of markup so the count cap, the colour
 * token and the accessible name cannot drift between them; the caller only
 * says which surface it is, for its test id.
 */

import { format, useI18n } from '@/i18n';
import { usePluginStore } from '@/stores/pluginStore';

/** Above this the exact number stops being useful and starts widening the row. */
const MAX_SHOWN = 9;

export default function PluginUpdateBadge({ testId }: { testId: string }) {
  const { t } = useI18n();
  const count = usePluginStore((s) => s.updateAvailableCount);
  if (count <= 0) return null;
  return (
    <span
      data-testid={testId}
      aria-label={format(t.toolbox.pluginsUpdatesAvailable, { count })}
      className="min-w-[18px] h-[18px] shrink-0 rounded-full bg-[var(--abu-danger-solid)] px-1.5 text-center text-caption font-medium leading-[18px] text-white"
    >
      {count > MAX_SHOWN ? `${MAX_SHOWN}+` : count}
    </span>
  );
}
