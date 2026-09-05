/**
 * The shape 「市场」 hands to 「我的」's add-server form, and the catalog it is
 * built from.
 *
 * There is one catalog: {@link BUILTIN_REGISTRY}, the same entries the agent
 * searches when it hits a capability gap. Every row is resolved per host (the
 * Electron build swaps the Chrome bridge's command), so a prefill describes
 * what this machine would actually run.
 *
 * `ConnectorPrefill` is deliberately *not* `MCPRegistryEntry`: the form needs
 * the intersection of what it can edit plus a transport, and it may also be
 * handed a connector from outside the catalog. Env vars arrive as keys with
 * empty values — a token slot, not a token — so the form opens describing the
 * connector while the user still supplies every secret.
 */

import { BUILTIN_REGISTRY, getEntryDescription, getRegistryEntry, type MCPRegistryEntry } from '@/core/agent/mcpDiscovery';

/** A proposed server config, filled into the add-server form for the user to complete. */
export interface ConnectorPrefill {
  name: string;
  command: string;
  args: string[];
  /** Env-var keys with empty values — slots to fill, never secrets. */
  env: Record<string, string>;
  transport?: 'stdio' | 'http';
  url?: string;
  description?: string;
  /**
   * The template view of this connector — every catalog row has one, since a
   * template is just the registry entry rendered for the install UI. It carries
   * affordances the plain add-server form has nowhere to put: a labeled secret
   * field with a hint, a configurable argument with a placeholder, a setup
   * note, a longer default timeout. 「我的」 opens that install flow instead of
   * the bare form.
   *
   * It is an offer, not a guarantee. The consumer resolves the id against its
   * own host-filtered template list and falls back to the fields beside it when
   * nothing matches, so a host that filtered the template out (Electron does,
   * for the Chrome bridge it provisions itself) can still add the connector
   * from the plain form. A prefill from outside the catalog names none.
   */
  templateId?: string;
}

/** A prefill plus the extra terms the catalog's search box matches on. */
export interface ConnectorCatalogItem extends ConnectorPrefill {
  /** The entry's registry keywords, which the search box matches beyond name and description. */
  keywords: string[];
}

function blankEnv(keys: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of keys) env[key] = '';
  return env;
}

function fromRegistry(entry: MCPRegistryEntry): ConnectorCatalogItem {
  // Resolved the way this host would actually run it, so the prefill matches
  // what an install would have produced.
  const resolved = getRegistryEntry(entry.name) ?? entry;
  return {
    name: resolved.name,
    command: resolved.command,
    args: [...resolved.args],
    env: blankEnv(Object.keys(resolved.env)),
    transport: 'stdio',
    description: getEntryDescription(resolved.name),
    templateId: resolved.name,
    keywords: [...resolved.keywords],
  };
}

/**
 * The connector catalog 「市场」 renders: every registry entry, host-resolved.
 * `_locale` is unused — descriptions resolve the current locale themselves —
 * but callers pass it so their memo recomputes when the language changes.
 */
export function buildConnectorCatalog(_locale: string): ConnectorCatalogItem[] {
  return BUILTIN_REGISTRY.map(fromRegistry);
}
