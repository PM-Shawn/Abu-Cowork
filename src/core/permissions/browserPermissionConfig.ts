import { normalizeBrowserOrigin, normalizeBrowserOperationPolicy, type BrowserOperationClass } from './browserToolPolicy';
import { resolveBrowserPermissionDefault, type BrowserDefaultDecision, type BrowserPermissionResource, type BrowserSiteOverride } from './browserPermissionDefaults';

export const BROWSER_PERMISSION_RESOURCES = ['browse', 'upload', 'script'] as const;
export type BrowserEmbeddedRule = Record<BrowserPermissionResource, BrowserSiteOverride>;
export interface BrowserSiteRule extends BrowserEmbeddedRule {
  blocked: boolean;
}
export interface BrowserPermissionConfig {
  schemaVersion: 2;
  defaults: Record<BrowserPermissionResource, BrowserDefaultDecision>;
  sites: Record<string, BrowserSiteRule>;
  embeddedSites: Record<string, Record<string, BrowserEmbeddedRule>>;
}
export interface BrowserPermissionTarget {
  origin: string | null;
  embeddedIn?: string | null;
}

export const emptyBrowserSiteRule = (): BrowserSiteRule => ({ blocked: false, browse: 'inherit', upload: 'inherit', script: 'inherit' });
export const createBrowserPermissionConfig = (): BrowserPermissionConfig => ({
  schemaVersion: 2, defaults: { browse: 'allow', upload: 'ask', script: 'ask' }, sites: {}, embeddedSites: {},
});
export const browserPermissionResourceFor = (opClass: BrowserOperationClass): BrowserPermissionResource =>
  opClass === 'scripting' ? 'script' : opClass === 'upload' ? 'upload' : 'browse';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isBrowserDefaultDecision(value: unknown): value is BrowserDefaultDecision {
  return value === 'allow' || value === 'ask' || value === 'deny';
}
export function isExactBrowserPermissionOrigin(origin: string): boolean {
  return normalizeBrowserOrigin(origin) === origin;
}
function validOverrides(value: Record<string, unknown>): boolean {
  return BROWSER_PERMISSION_RESOURCES.every((key) => Object.hasOwn(value, key)
    && (value[key] === 'inherit' || isBrowserDefaultDecision(value[key])));
}

/** Older V2 blobs have no embedded map; normalizing them does not add grants. */
export function parseBrowserPermissionConfig(value: unknown): BrowserPermissionConfig | null {
  if (!record(value) || value.schemaVersion !== 2 || !record(value.defaults) || !record(value.sites)) return null;
  if (Object.keys(value).some((key) => !['schemaVersion', 'defaults', 'sites', 'embeddedSites'].includes(key))) return null;
  const defaults = value.defaults;
  if (Object.keys(defaults).length !== 3 || !BROWSER_PERMISSION_RESOURCES.every((key) => Object.hasOwn(defaults, key) && isBrowserDefaultDecision(defaults[key]))) return null;
  for (const [origin, rule] of Object.entries(value.sites)) {
    if (!isExactBrowserPermissionOrigin(origin) || !record(rule) || typeof rule.blocked !== 'boolean') return null;
    if (Object.keys(rule).length !== 4 || !validOverrides(rule)) return null;
  }
  const embeddedSites = Object.hasOwn(value, 'embeddedSites') ? value.embeddedSites : {};
  if (!record(embeddedSites)) return null;
  for (const [topOrigin, sites] of Object.entries(embeddedSites)) {
    if (!isExactBrowserPermissionOrigin(topOrigin) || !record(sites)) return null;
    for (const [origin, rule] of Object.entries(sites)) {
      if (!isExactBrowserPermissionOrigin(origin) || !record(rule) || Object.keys(rule).length !== 3 || !validOverrides(rule)) return null;
    }
  }
  return { ...value, embeddedSites } as unknown as BrowserPermissionConfig;
}

/** Configuration only: execution still checks approval, frame identity and run limits. */
export function resolveBrowserPermissionConfig(value: unknown, resource: BrowserPermissionResource, targets: readonly BrowserPermissionTarget[]) {
  const config = parseBrowserPermissionConfig(value);
  if (!config) return { decision: 'deny', source: 'invalid-config' } as const;
  if (!targets.length || targets.some(({ origin, embeddedIn }) => !origin || !isExactBrowserPermissionOrigin(origin)
    || (embeddedIn != null && !isExactBrowserPermissionOrigin(embeddedIn)))) {
    return { decision: 'deny', source: 'unverified-origin' } as const;
  }
  // Include each necessary host page even when the caller supplies only its frame.
  const involved = targets.flatMap((target) => target.embeddedIn
    ? [target, { origin: target.embeddedIn }]
    : [target]);
  const results = involved.map(({ origin, embeddedIn }) => {
    const site = config.sites[origin!];
    if (site?.blocked) return { decision: 'deny', source: 'site-block' } as const;
    if (site?.[resource] === 'deny') return { decision: 'deny', source: 'site' } as const;
    const embedded = embeddedIn ? config.embeddedSites[embeddedIn]?.[origin!]?.[resource] : undefined;
    if (embedded && embedded !== 'inherit') return { decision: embedded, source: 'embedded-site' } as const;
    return resolveBrowserPermissionDefault({ defaults: config.defaults, resource, siteBlocked: false, siteOverride: site?.[resource] });
  });
  return results.find((result) => result.source === 'site-block')
    ?? results.find((result) => result.decision === 'deny')
    ?? results.find((result) => result.decision === 'ask')
    ?? results[0];
}

/** A confirmation may grant only its named resource and verified scopes.
 * Call this under the persistence lock; a newer denial cancels the whole grant.
 * This does not decide whether a request may offer persistence (risk/run checks
 * remain with the requester), and scripts never receive persistent approval here.
 */
export function grantBrowserPermissionTargets(
  value: unknown, resource: BrowserPermissionResource, targets: readonly BrowserPermissionTarget[],
): BrowserPermissionConfig | null {
  const config = parseBrowserPermissionConfig(value);
  if (!config || resolveBrowserPermissionConfig(config, resource, targets).decision === 'deny') return null;
  const next = { ...config, sites: { ...config.sites }, embeddedSites: { ...config.embeddedSites } };
  for (const { origin, embeddedIn } of targets) {
    // The resolver has validated both origins and the necessary host page.
    if (embeddedIn) {
      next.embeddedSites[embeddedIn] = { ...next.embeddedSites[embeddedIn], [origin!]: {
        ...(next.embeddedSites[embeddedIn]?.[origin!] ?? { browse: 'inherit', upload: 'inherit', script: 'inherit' }),
        [resource]: 'allow',
      } };
      next.sites[embeddedIn] = { ...emptyBrowserSiteRule(), ...next.sites[embeddedIn], [resource]: 'allow' };
    } else {
      next.sites[origin!] = { ...emptyBrowserSiteRule(), ...next.sites[origin!], [resource]: 'allow' };
    }
  }
  return next;
}

/** Only used while decoding persisted settings; never a second runtime gate. */
export function migrateBrowserPermissionConfig(settings: unknown): BrowserPermissionConfig {
  const closed = (): BrowserPermissionConfig => {
    const config: BrowserPermissionConfig = { ...createBrowserPermissionConfig(), defaults: { browse: 'deny', upload: 'deny', script: 'deny' } };
    if (!record(settings)) return config;
    // A malformed unrelated entry cannot erase a known ban. Retain only
    // negative authority, so later default edits do not silently lift it.
    if (record(settings.browserSitePermissions)) {
      for (const [origin, verdict] of Object.entries(settings.browserSitePermissions)) {
        if (isExactBrowserPermissionOrigin(origin) && verdict === 'denied') config.sites[origin] = { ...emptyBrowserSiteRule(), blocked: true };
      }
    }
    const raw = settings.browserPermissionConfigV2;
    if (!record(raw)) return config;
    const deniedOverrides = (rule: Record<string, unknown>): BrowserEmbeddedRule => ({
      browse: rule.browse === 'deny' ? 'deny' : 'inherit',
      upload: rule.upload === 'deny' ? 'deny' : 'inherit',
      script: rule.script === 'deny' ? 'deny' : 'inherit',
    });
    if (record(raw.sites)) {
      for (const [origin, rule] of Object.entries(raw.sites)) {
        if (!isExactBrowserPermissionOrigin(origin) || !record(rule)) continue;
        const denied = deniedOverrides(rule);
        if (rule.blocked === true || Object.values(denied).includes('deny')) {
          config.sites[origin] = { blocked: config.sites[origin]?.blocked === true || rule.blocked === true, ...denied };
        }
      }
    }
    if (record(raw.embeddedSites)) {
      for (const [topOrigin, sites] of Object.entries(raw.embeddedSites)) {
        if (!isExactBrowserPermissionOrigin(topOrigin) || !record(sites)) continue;
        for (const [origin, rule] of Object.entries(sites)) {
          if (!isExactBrowserPermissionOrigin(origin) || !record(rule)) continue;
          const denied = deniedOverrides(rule);
          if (Object.values(denied).includes('deny')) (config.embeddedSites[topOrigin] ??= {})[origin] = denied;
        }
      }
    }
    return config;
  };
  if (!record(settings)) return closed();
  if (settings.browserPermissionConfigV2 != null) return parseBrowserPermissionConfig(settings.browserPermissionConfigV2) ?? closed();
  const policy = normalizeBrowserOperationPolicy(settings.browserOperationPolicy);
  const rows: Record<BrowserPermissionResource, unknown[]> = {
    browse: [policy.readOnly, policy.interactive], upload: [policy.upload], script: [policy.scripting],
  };
  const config = createBrowserPermissionConfig();
  for (const resource of BROWSER_PERMISSION_RESOURCES) {
    config.defaults[resource] = rows[resource].includes('deny') ? 'deny' : 'ask';
  }
  const grants = settings.browserSitePermissions;
  if (grants != null && !record(grants)) return closed();
  const scopes = settings.browserSiteGrantViaEmbed;
  if (scopes != null && !record(scopes)) return closed();
  const migratedOverrides = (): BrowserEmbeddedRule => Object.fromEntries(BROWSER_PERMISSION_RESOURCES.map((resource) => [resource,
    config.defaults[resource] === 'deny' ? 'deny'
      : settings.allowUnattendedBrowser === true && rows[resource].every((value) => value === 'allow') ? 'allow' : 'ask',
  ])) as BrowserEmbeddedRule;
  for (const [origin, verdict] of Object.entries(grants ?? {})) {
    if (!isExactBrowserPermissionOrigin(origin) || (verdict !== 'denied' && verdict !== 'allowed')) return closed();
    if (verdict === 'denied') {
      config.sites[origin] = { ...emptyBrowserSiteRule(), blocked: true };
      continue;
    }
    if (record(scopes) && Object.hasOwn(scopes, origin)) {
      const scope = scopes[origin];
      // Legacy unknown scope is tightened to ask, never promoted to a top-level grant.
      if (!record(scope)) continue;
      for (const [topOrigin, granted] of Object.entries(scope)) {
        if (granted !== true || !isExactBrowserPermissionOrigin(topOrigin)) continue;
        (config.embeddedSites[topOrigin] ??= {})[origin] = migratedOverrides();
      }
    } else {
      config.sites[origin] = { blocked: false, ...migratedOverrides() };
    }
  }
  return config;
}
