/**
 * The shape 「市场」 hands to 「我的」's add-server form, and the union catalog it
 * is built from.
 *
 * Abu ships **two** connector catalogs that predate this tab:
 * {@link BUILTIN_REGISTRY} (what the agent searches when it hits a capability
 * gap) and the marketplace templates (what the old 示例 cards installed). They
 * overlap by ten names and disagree about five: `playwright`, `docker`,
 * `sentry`, `linear` and `chrome-devtools` exist only as templates. Once 「我的」
 * stopped rendering un-installed template cards, those five had no surface left
 * anywhere in the app — so 「市场」 lists the union, deduplicated by name, minus
 * the ones whose package npm does not have (see
 * {@link UNPUBLISHED_TEMPLATE_PACKAGES}).
 *
 * A registry entry wins a name collision outright: it is the one resolved per
 * host (the Electron build swaps the Chrome bridge's command), so it describes
 * what this machine would actually run — and the two catalogs disagree about
 * the npm package for nine of their ten shared names, where the registry's
 * `@modelcontextprotocol/*` packages are the published ones. A collision
 * therefore carries no `templateId`: routing it through the template install
 * flow would run the template's command, which is the unpublished one.
 *
 * `ConnectorPrefill` is deliberately *not* `MCPRegistryEntry`: the two catalogs
 * carry different metadata (a template can be HTTP, a registry entry cannot),
 * and the form needs the intersection plus a transport. Env vars arrive as keys
 * with empty values — a token slot, not a token — so the form opens describing
 * the connector while the user still supplies every secret.
 */

import { BUILTIN_REGISTRY, getEntryDescription, getRegistryEntry, type MCPRegistryEntry } from '@/core/agent/mcpDiscovery';
import { getMCPTemplatesForHost } from '@/data/marketplace/mcp';
import type { MCPTemplate } from '@/types/marketplace';

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
   * The marketplace template that describes this connector, when one does. A
   * template carries install affordances the plain add-server form has nowhere
   * to put — a labeled secret field with a hint, a configurable argument with a
   * placeholder, a setup note, a longer default timeout — so 「我的」 opens that
   * template's own install flow instead of the bare form. Only a connector the
   * registry does *not* carry gets one — a name both catalogs know belongs to
   * the registry outright.
   *
   * It is an offer, not a guarantee. The consumer resolves the id against its
   * own host-filtered template list and falls back to the fields beside it when
   * nothing matches, so a host that filtered the template out can still add the
   * connector from the plain form.
   */
  templateId?: string;
}

/**
 * npm packages named by `mcpTemplates` that do not exist on the registry —
 * every one of them 404s on `npm view` as of **2026-09-05**. A template-only
 * row is the only surface a connector has, and its 「添加」 ends in
 * `npx -y <package>`, so offering these promises an install that cannot
 * succeed. 「市场」 withholds such a row instead.
 *
 * **Follow-up:** the real fix is in the template data — `src/data/marketplace/mcp.ts`
 * should name published packages (as the registry's `@modelcontextprotocol/*`
 * entries do). Shrink this set as those are corrected; it is a shield over
 * stale data, not a policy.
 */
export const UNPUBLISHED_TEMPLATE_PACKAGES: ReadonlySet<string> = new Set([
  '@anthropic/mcp-server-docker',
  '@anthropic/mcp-server-linear',
  '@sentry/mcp-server-sentry',
]);

/** `@scope/name@1.2.3` / `name@latest` → the package name the deny-list holds. */
function packageBaseName(arg: string): string {
  const at = arg.lastIndexOf('@');
  return at > 0 ? arg.slice(0, at) : arg;
}

/** True when a template would install a package npm does not have. */
function namesUnpublishedPackage(template: MCPTemplate): boolean {
  return (template.defaultArgs ?? []).some((arg) => UNPUBLISHED_TEMPLATE_PACKAGES.has(packageBaseName(arg)));
}

/** A prefill plus the extra terms the catalog's search box matches on. */
export interface ConnectorCatalogItem extends ConnectorPrefill {
  /** Registry keywords; empty for a template, which has only name + description. */
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
    keywords: [...resolved.keywords],
  };
}

function fromTemplate(template: MCPTemplate, locale: string): ConnectorCatalogItem {
  const isHttp = template.transport === 'http' && !!template.url;
  return {
    name: template.name,
    command: isHttp ? '' : (template.command ?? 'npx'),
    args: isHttp ? [] : [...(template.defaultArgs ?? [])],
    env: blankEnv((template.requiredEnvVars ?? []).map((v) => v.name)),
    transport: isHttp ? 'http' : 'stdio',
    url: isHttp ? template.url : undefined,
    description: locale.startsWith('zh') ? template.description : (template.descriptionEn ?? template.description),
    templateId: template.id,
    keywords: [],
  };
}

/**
 * The connector catalog 「市场」 renders: every registry entry, then every
 * template the registry does not already name. `locale` selects a template's
 * localized description (registry descriptions resolve their own locale).
 */
export function buildConnectorCatalog(locale: string): ConnectorCatalogItem[] {
  const items = BUILTIN_REGISTRY.map(fromRegistry);
  const claimed = new Set(items.map((item) => item.name));
  for (const template of getMCPTemplatesForHost()) {
    if (claimed.has(template.name)) continue;
    // A template-only row is this connector's only surface; withholding it
    // beats offering an install that 404s.
    if (namesUnpublishedPackage(template)) continue;
    claimed.add(template.name);
    items.push(fromTemplate(template, locale));
  }
  return items;
}
