import type { SubagentMetadata } from '@/types';

/**
 * True when a plugin owns this agent's AGENT.md.
 *
 * `SubagentMetadata.source` is written by the installer (and backfilled from
 * `installed.json` for agents installed before the key existed) — never by the
 * package itself. The consequence for the UI is uniform wherever an agent is
 * shown or acted on: an edit would be overwritten by the next plugin update,
 * and removing the file belongs to uninstalling the plugin. Kept as one shared
 * predicate so the gate (a disabled button) and the invariant behind it (an
 * early return in the handler) can never disagree.
 */
export function isPluginOwnedAgent(agent: Pick<SubagentMetadata, 'source'>): boolean {
  return agent.source?.kind === 'plugin';
}
