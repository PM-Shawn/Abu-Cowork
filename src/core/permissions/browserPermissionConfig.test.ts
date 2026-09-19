import { describe, expect, it } from 'vitest';
import {
  grantBrowserPermissionTargets, BROWSER_PERMISSION_RESOURCES, browserPermissionResourceFor, createBrowserPermissionConfig,
  emptyBrowserSiteRule, migrateBrowserPermissionConfig, parseBrowserPermissionConfig, resolveBrowserPermissionConfig,
} from './browserPermissionConfig';

const top = 'https://app.example';
const frame = 'https://embed.example';
const other = 'https://other.example';
const allowPolicy = { readOnly: 'allow', interactive: 'allow', upload: 'allow', scripting: 'allow' };
const legacy = (extra: Record<string, unknown> = {}) => ({
  browserOperationPolicy: allowPolicy, allowUnattendedBrowser: true,
  browserSitePermissions: { [top]: 'allowed', [frame]: 'allowed' }, ...extra,
});

describe('browser permission configuration', () => {
  it('gives fresh installs explicit defaults and maps operation classes', () => {
    expect(createBrowserPermissionConfig().defaults).toEqual({ browse: 'allow', upload: 'ask', script: 'ask' });
    expect(['read-only', 'interactive', 'upload', 'scripting'].map((operation) =>
      browserPermissionResourceFor(operation as Parameters<typeof browserPermissionResourceFor>[0]))).toEqual(['browse', 'browse', 'upload', 'script']);
  });

  it('keeps valid V2 preferences and normalizes only its absent embedded map', () => {
    const saved = { schemaVersion: 2, defaults: { browse: 'deny', upload: 'allow', script: 'ask' }, sites: {} };
    expect(migrateBrowserPermissionConfig({ browserPermissionConfigV2: saved })).toEqual({ ...saved, embeddedSites: {} });
  });

  it.each([null, [], {}, { ...createBrowserPermissionConfig(), extra: true },
    { ...createBrowserPermissionConfig(), embeddedSites: null },
    { ...createBrowserPermissionConfig(), defaults: { browse: 'allow', upload: 'allow', script: 'bad' } },
    { ...createBrowserPermissionConfig(), sites: { 'https://example.com/path': emptyBrowserSiteRule() } },
    { ...createBrowserPermissionConfig(), embeddedSites: { [top]: { [frame]: { browse: 'allow' } } } },
    { ...createBrowserPermissionConfig(), embeddedSites: { 'file:///tmp': {} } },
  ])('rejects malformed configuration without fresh-install fallback: %j', (value) => {
    expect(parseBrowserPermissionConfig(value)).toBeNull();
    expect(resolveBrowserPermissionConfig(value, 'browse', [{ origin: top }]).decision).toBe('deny');
  });

  it.each([{ targets: [] }, { targets: [{ origin: null }] }, { targets: [{ origin: 'https://app.example/path' }] },
    { targets: [{ origin: frame, embeddedIn: 'javascript:alert(1)' }] },
  ])('refuses unverified necessary origins: %j', ({ targets }) => {
    expect(resolveBrowserPermissionConfig(createBrowserPermissionConfig(), 'browse', targets).decision).toBe('deny');
  });

  it('applies frame authorization only inside its original host', () => {
    const config = migrateBrowserPermissionConfig(legacy({ browserSiteGrantViaEmbed: { [frame]: { [top]: true } } }));
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: frame, embeddedIn: top }]).decision).toBe('allow');
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: frame }]).decision).toBe('ask');
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: frame, embeddedIn: other }]).decision).toBe('ask');
  });

  it('checks the host page even when only its embedded target is supplied', () => {
    const config = migrateBrowserPermissionConfig(legacy({ browserSiteGrantViaEmbed: { [frame]: { [top]: true } } }));
    config.sites[top].blocked = true;
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: frame, embeddedIn: top }])).toEqual({ decision: 'deny', source: 'site-block' });
  });

  it('never overrides a site deny with a frame grant, but permits explicit exceptions to defaults', () => {
    const config = createBrowserPermissionConfig();
    config.defaults.browse = 'deny';
    config.sites[top] = { ...emptyBrowserSiteRule(), browse: 'allow' };
    config.embeddedSites[top] = { [frame]: { browse: 'allow', upload: 'inherit', script: 'inherit' } };
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: frame, embeddedIn: top }]).decision).toBe('allow');
    config.sites[frame] = { ...emptyBrowserSiteRule(), browse: 'deny' };
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: frame, embeddedIn: top }]).decision).toBe('deny');
    config.sites[frame].blocked = true;
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: frame, embeddedIn: top }]).source).toBe('site-block');
  });

  it('uses the strictest result across all necessary origins', () => {
    const config = createBrowserPermissionConfig();
    config.sites[top] = { ...emptyBrowserSiteRule(), browse: 'ask' };
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: other }, { origin: top }]).decision).toBe('ask');
    config.sites[frame] = { ...emptyBrowserSiteRule(), browse: 'deny' };
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: other }, { origin: top }, { origin: frame }]).decision).toBe('deny');
  });
});

describe('one-time conservative migration', () => {
  it('never promotes legacy unknown-site authorization to default allow', () => {
    const config = migrateBrowserPermissionConfig(legacy());
    expect(config.defaults).toEqual({ browse: 'ask', upload: 'ask', script: 'ask' });
    expect(config.sites[top]).toEqual({ blocked: false, browse: 'allow', upload: 'allow', script: 'allow' });
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: other }]).decision).toBe('ask');
  });

  it.each([false, undefined, 'true', 1])('clamps defaults AND every scoped override when old automation was disabled: %j', (enabled) => {
    const config = migrateBrowserPermissionConfig(legacy({ allowUnattendedBrowser: enabled, browserSiteGrantViaEmbed: { [frame]: { [top]: true } } }));
    for (const resource of BROWSER_PERMISSION_RESOURCES) {
      expect(config.defaults[resource]).toBe('ask');
      expect(config.sites[top][resource]).toBe('ask');
      expect(config.embeddedSites[top][frame][resource]).toBe('ask');
    }
  });

  it.each(['readOnly', 'interactive', 'upload', 'scripting'])('retains an explicit operation deny for defaults and grants: %s', (operation) => {
    const config = migrateBrowserPermissionConfig(legacy({
      browserOperationPolicy: { ...allowPolicy, [operation]: 'deny' },
      browserSiteGrantViaEmbed: { [frame]: { [top]: true } },
    }));
    const resource = operation === 'upload' ? 'upload' : operation === 'scripting' ? 'script' : 'browse';
    expect(config.defaults[resource]).toBe('deny');
    expect(config.sites[top][resource]).toBe('deny');
    expect(config.embeddedSites[top][frame][resource]).toBe('deny');
  });

  it('preserves earlier two-column attended denials through the existing normalizer', () => {
    expect(migrateBrowserPermissionConfig(legacy({ browserOperationPolicy: { attended: { ...allowPolicy, interactive: 'deny' } } })).defaults.browse).toBe('deny');
  });

  it('preserves whole-site blocks even for malformed/legacy embedded scopes', () => {
    const config = migrateBrowserPermissionConfig(legacy({ browserSitePermissions: { [frame]: 'denied' }, browserSiteGrantViaEmbed: { [frame]: true } }));
    expect(config.sites[frame].blocked).toBe(true);
  });

  it('preserves known site blocks when another legacy entry is corrupt, even after changing defaults', () => {
    const config = migrateBrowserPermissionConfig(legacy({ browserSitePermissions: { [top]: 'denied', [other]: 'bad' } }));
    config.defaults.browse = 'allow';
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: top }]).decision).toBe('deny');
  });

  it('salvages only negative V2 authority from malformed data', () => {
    const config = migrateBrowserPermissionConfig({ browserPermissionConfigV2: {
      ...createBrowserPermissionConfig(), defaults: 'bad',
      sites: {
        [top]: { blocked: true, browse: 'allow' },
        [frame]: { blocked: false, upload: 'deny', script: 'allow' },
        [other]: { blocked: false, browse: 'allow' },
      },
      embeddedSites: { [other]: { [frame]: { browse: 'deny', upload: 'allow' } } },
    } });
    config.defaults = { browse: 'allow', upload: 'allow', script: 'allow' };
    expect(config.sites[top].blocked).toBe(true);
    expect(config.sites[frame]).toEqual({ blocked: false, browse: 'inherit', upload: 'deny', script: 'inherit' });
    expect(config.sites[other]).toBeUndefined();
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: frame, embeddedIn: other }]).decision).toBe('deny');
    expect(resolveBrowserPermissionConfig(config, 'upload', [{ origin: frame }]).decision).toBe('deny');
  });

  it.each([{}, true, null, 'bad', { [top]: false }, { 'https://app.example/path': true }])('does not promote unknown or corrupt embedded scope to a full grant: %j', (scope) => {
    const config = migrateBrowserPermissionConfig(legacy({ browserSiteGrantViaEmbed: { [frame]: scope } }));
    expect(config.sites[frame]).toBeUndefined();
    expect(config.embeddedSites).toEqual({});
    expect(resolveBrowserPermissionConfig(config, 'browse', [{ origin: frame }]).decision).toBe('ask');
  });

  it.each([{}, { browserPermissionConfigV2: null }])('distinguishes an existing empty store from a fresh install: %j', (saved) => {
    expect(migrateBrowserPermissionConfig(saved).defaults).toEqual({ browse: 'ask', upload: 'ask', script: 'ask' });
  });

  it.each([null, { browserPermissionConfigV2: {} }, { browserSitePermissions: [] },
    { browserSiteGrantViaEmbed: [] }, { browserSitePermissions: { [top]: 'bad' } },
    { browserSitePermissions: { 'file:///tmp': 'denied' } },
  ])('fails closed on unreadable persisted grants: %j', (saved) => {
    expect(migrateBrowserPermissionConfig(saved).defaults).toEqual({ browse: 'deny', upload: 'deny', script: 'deny' });
  });

  it('does not mutate source settings or persisted V2 during migration', () => {
    const saved = legacy({ browserSiteGrantViaEmbed: { [frame]: { [top]: true } } });
    const before = JSON.stringify(saved);
    const config = migrateBrowserPermissionConfig(saved);
    config.sites[top].blocked = true;
    expect(JSON.stringify(saved)).toBe(before);
  });
});


describe('persistent confirmation scope', () => {
  it('grants upload for the named frame in its host without granting standalone or other resources', () => {
    const before = createBrowserPermissionConfig();
    const next = grantBrowserPermissionTargets(before, 'upload', [{ origin: frame, embeddedIn: top }])!;
    expect(resolveBrowserPermissionConfig(next, 'upload', [{ origin: frame, embeddedIn: top }]).decision).toBe('allow');
    expect(resolveBrowserPermissionConfig(next, 'upload', [{ origin: frame }]).decision).toBe('ask');
    expect(resolveBrowserPermissionConfig(next, 'upload', [{ origin: frame, embeddedIn: other }]).decision).toBe('ask');
    expect(next.sites[frame]).toBeUndefined();
    expect(next.sites[top]).toEqual({ ...emptyBrowserSiteRule(), upload: 'allow' });
    expect(next.embeddedSites[top][frame]).toEqual({ browse: 'inherit', upload: 'allow', script: 'inherit' });
    expect(before).toEqual(createBrowserPermissionConfig());
  });

  it.each(['host', 'frame', 'scoped', 'default'])('rejects the complete grant when %s denies the operation', (source) => {
    const config = createBrowserPermissionConfig();
    if (source === 'host') config.sites[top] = { ...emptyBrowserSiteRule(), blocked: true };
    if (source === 'frame') config.sites[frame] = { ...emptyBrowserSiteRule(), upload: 'deny' };
    if (source === 'scoped') config.embeddedSites[top] = { [frame]: { browse: 'inherit', upload: 'deny', script: 'inherit' } };
    if (source === 'default') config.defaults.upload = 'deny';
    const before = JSON.stringify(config);
    expect(grantBrowserPermissionTargets(config, 'upload', [{ origin: other }, { origin: frame, embeddedIn: top }])).toBeNull();
    expect(JSON.stringify(config)).toBe(before);
  });

  it('refuses scripting, invalid configurations and unresolved scopes', () => {
    expect(grantBrowserPermissionTargets(createBrowserPermissionConfig(), 'script', [{ origin: top }])).toBeNull();
    expect(grantBrowserPermissionTargets(null, 'upload', [{ origin: top }])).toBeNull();
    expect(grantBrowserPermissionTargets(createBrowserPermissionConfig(), 'upload', [])).toBeNull();
    expect(grantBrowserPermissionTargets(createBrowserPermissionConfig(), 'upload', [{ origin: null }])).toBeNull();
  });
});
