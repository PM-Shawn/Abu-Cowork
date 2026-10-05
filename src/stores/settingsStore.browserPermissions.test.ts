import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore, __resetBrowserConfigPersistenceForTests, initialBrowserPermissionConfig, readConfirmedBrowserPermissionConfig } from './settingsStore';
import { useBrowserSaveStatusStore } from './browserSaveStatus';
import { INITIAL_BROWSER_CONFIG_REVISIONS } from './browserConfigPersistence';
import { createBrowserPermissionConfig, emptyBrowserSiteRule } from '@/core/permissions/browserPermissionConfig';

let queue: Promise<unknown>;
const request = vi.fn((_name: string, callback: () => unknown) => {
  const job = queue.then(callback);
  queue = job.catch(() => undefined);
  return job;
});
async function drained() { await queue; }
beforeEach(async () => {
  queue = Promise.resolve();
  request.mockClear();
  vi.stubGlobal('navigator', { locks: { request } });
  localStorage.clear();
  __resetBrowserConfigPersistenceForTests();
  useBrowserSaveStatusStore.getState().__resetBrowserSaveStatus();
  useSettingsStore.setState({ browserPermissionConfigV2: createBrowserPermissionConfig(), browserConfigRevisions: { ...INITIAL_BROWSER_CONFIG_REVISIONS } });
  await drained();
});
afterEach(async () => { await drained(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const SITE = 'https://files.example';

describe('new browser permission saving', () => {
  it('persists only the requested origin/resource after confirmed readback', async () => {
    expect(await useSettingsStore.getState().setBrowserSiteResourcePermission(SITE, 'upload', 'allow')).toBe(true);
    const stored = JSON.parse(localStorage.getItem('abu-settings')!);
    expect(stored.state.browserPermissionConfigV2.sites).toEqual({ [SITE]: { ...emptyBrowserSiteRule(), upload: 'allow' } });
  });
  it('preserves a newer site block when editing another resource from stale memory', async () => {
    const disk = JSON.parse(localStorage.getItem('abu-settings')!);
    disk.state.browserPermissionConfigV2.sites[SITE] = { ...emptyBrowserSiteRule(), blocked: true };
    disk.state.browserConfigRevisions.browserPermissionConfigV2 = 9;
    localStorage.setItem('abu-settings', JSON.stringify(disk));
    await useSettingsStore.getState().setBrowserSiteResourcePermission(SITE, 'upload', 'allow');
    expect(useSettingsStore.getState().browserPermissionConfigV2?.sites[SITE]).toEqual({ ...emptyBrowserSiteRule(), blocked: true, upload: 'allow' });
  });
  it('rolls back a failed write, and retries the single edit against a newer block', async () => {
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    expect(await useSettingsStore.getState().setBrowserSiteResourcePermission(SITE, 'upload', 'allow')).toBe(false);
    expect(useSettingsStore.getState().browserPermissionConfigV2?.sites[SITE]).toBeUndefined();
    write.mockRestore();
    const disk = JSON.parse(localStorage.getItem('abu-settings')!);
    disk.state.browserPermissionConfigV2.sites[SITE] = { ...emptyBrowserSiteRule(), blocked: true };
    disk.state.browserConfigRevisions.browserPermissionConfigV2 = 4;
    localStorage.setItem('abu-settings', JSON.stringify(disk));
    useSettingsStore.getState().retryBrowserConfigSave('browserPermissionConfigV2');
    await drained();
    expect(useSettingsStore.getState().browserPermissionConfigV2?.sites[SITE]).toEqual({ ...emptyBrowserSiteRule(), blocked: true, upload: 'allow' });
    expect(useBrowserSaveStatusStore.getState().status.browserPermissionConfigV2).toBe('saved');
  });
  it('serializes a permission edit and an ordinary blob save behind the same lock', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    request('external-window', () => held);
    const permission = useSettingsStore.getState().setBrowserSiteBlocked(SITE, true);
    useSettingsStore.getState().setUserNickname('Test reader');
    expect(useBrowserSaveStatusStore.getState().status.browserPermissionConfigV2).toBe('saving');
    release();
    expect(await permission).toBe(true);
    await drained();
    const disk = JSON.parse(localStorage.getItem('abu-settings')!);
    expect(disk.state.browserPermissionConfigV2.sites[SITE].blocked).toBe(true);
    expect(disk.state.userNickname).toBe('Test reader');
  });
  it('does not write a persistent grant after its request is cancelled while waiting for the lock', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    request('another-window', () => held);
    let active = true;
    const save = useSettingsStore.getState().setBrowserSiteResourcePermission(SITE, 'upload', 'allow', () => active);
    active = false;
    release();
    expect(await save).toBe(false);
    expect(useSettingsStore.getState().browserPermissionConfigV2?.sites[SITE]).toBeUndefined();
  });
  it('never writes an unmerged blob when the permission read fails', async () => {
    const stored = localStorage.getItem('abu-settings');
    const write = vi.spyOn(localStorage, 'setItem');
    const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('read failed'); });
    useSettingsStore.getState().setUserNickname('Unsaved edit');
    await drained();
    expect(write).not.toHaveBeenCalled();
    read.mockRestore();
    expect(localStorage.getItem('abu-settings')).toBe(stored);
  });
  it('refuses a low-revision corrupt config before considering its revision', async () => {
    await useSettingsStore.getState().setBrowserPermissionDefault('browse', 'allow');
    const disk = JSON.parse(localStorage.getItem('abu-settings')!);
    disk.state.browserPermissionConfigV2 = { schemaVersion: 77 };
    disk.state.browserConfigRevisions.browserPermissionConfigV2 = 0;
    localStorage.setItem('abu-settings', JSON.stringify(disk));
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState())?.defaults.browse).toBe('deny');
    useSettingsStore.getState().setUserNickname('Do not replace corrupt permission data');
    await drained();
    expect(JSON.parse(localStorage.getItem('abu-settings')!).state.browserPermissionConfigV2).toEqual({ schemaVersion: 77 });
  });
  it('never falls back to legacy when a lower-revision disk blob lost its V2 field', async () => {
    await useSettingsStore.getState().setBrowserPermissionDefault('browse', 'allow');
    const disk = JSON.parse(localStorage.getItem('abu-settings')!);
    delete disk.state.browserPermissionConfigV2;
    disk.state.browserConfigRevisions.browserPermissionConfigV2 = 0;
    localStorage.setItem('abu-settings', JSON.stringify(disk));
    expect(await useSettingsStore.getState().setBrowserPermissionDefault('upload', 'allow')).toBe(false);
    expect(useSettingsStore.getState().browserPermissionConfigV2).not.toBeNull();
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState())?.defaults.browse).toBe('deny');
    useSettingsStore.getState().restoreBrowserConfigField('browserPermissionConfigV2', undefined, 0);
    await drained();
    expect(useSettingsStore.getState().browserPermissionConfigV2?.defaults.browse).toBe('deny');
    expect(JSON.parse(localStorage.getItem('abu-settings')!).state.browserPermissionConfigV2).toBeUndefined();
  });
  it('fails without shared locks and rejects malformed data instead of using legacy permissions', async () => {
    vi.stubGlobal('navigator', {});
    expect(await useSettingsStore.getState().setBrowserPermissionDefault('browse', 'allow')).toBe(false);
    useSettingsStore.getState().restoreBrowserConfigField('browserPermissionConfigV2', { schemaVersion: 77 }, 5);
    expect(useSettingsStore.getState().browserPermissionConfigV2.defaults).toEqual({ browse: 'deny', upload: 'deny', script: 'deny' });
  });
});

describe('new profile initialization and confirmed reads', () => {
  it('gives only a truly empty profile new defaults; migrates old profiles conservatively', () => {
    localStorage.removeItem('abu-settings');
    expect(initialBrowserPermissionConfig()).toEqual(createBrowserPermissionConfig());
    localStorage.setItem('abu-settings', JSON.stringify({ version: 51, state: {} }));
    expect(initialBrowserPermissionConfig().defaults).toEqual({ browse: 'ask', upload: 'ask', script: 'ask' });
  });
  it('fails closed for corrupt persisted bytes and malformed current schemas', () => {
    localStorage.setItem('abu-settings', '{broken');
    expect(initialBrowserPermissionConfig()?.defaults.browse).toBe('deny');
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState())?.defaults.browse).toBe('deny');
    localStorage.setItem('abu-settings', JSON.stringify({ version: 52, state: { browserPermissionConfigV2: { schemaVersion: 77 } } }));
    expect(initialBrowserPermissionConfig().defaults).toEqual({ browse: 'deny', upload: 'deny', script: 'deny' });
  });
  it("reads another window’s confirmed block without waiting for its storage event", () => {
    const disk = JSON.parse(localStorage.getItem('abu-settings')!);
    disk.state.browserPermissionConfigV2.sites[SITE] = { ...emptyBrowserSiteRule(), blocked: true };
    disk.state.browserConfigRevisions.browserPermissionConfigV2 = 7;
    localStorage.setItem('abu-settings', JSON.stringify(disk));
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState())?.sites[SITE].blocked).toBe(true);
  });
});

describe('atomic single-site edits', () => {
  const browsing = { ...emptyBrowserSiteRule(), browse: 'allow' as const };
  it('saves all custom resources in one confirmed write and one revision', async () => {
    const before = useSettingsStore.getState().browserConfigRevisions.browserPermissionConfigV2;
    const write = vi.spyOn(localStorage, 'setItem');
    const rule = { blocked: false, browse: 'ask' as const, upload: 'allow' as const, script: 'deny' as const };
    expect(await useSettingsStore.getState().setBrowserSiteRule(SITE, rule, null)).toBe('saved');
    expect(write).toHaveBeenCalledOnce();
    const stored = JSON.parse(localStorage.getItem('abu-settings')!);
    expect(stored.state.browserPermissionConfigV2.sites[SITE]).toEqual(rule);
    expect(stored.state.browserConfigRevisions.browserPermissionConfigV2).toBe(before + 1);
  });
  it('merges unrelated website edits but rejects a changed target before writing', async () => {
    const disk = JSON.parse(localStorage.getItem('abu-settings')!);
    disk.state.browserPermissionConfigV2.sites['https://other.example'] = { ...emptyBrowserSiteRule(), blocked: true };
    disk.state.browserConfigRevisions.browserPermissionConfigV2 = 7;
    localStorage.setItem('abu-settings', JSON.stringify(disk));
    expect(await useSettingsStore.getState().setBrowserSiteRule(SITE, browsing, null)).toBe('saved');
    expect(useSettingsStore.getState().browserPermissionConfigV2?.sites['https://other.example'].blocked).toBe(true);
    const newer = JSON.parse(localStorage.getItem('abu-settings')!);
    newer.state.browserPermissionConfigV2.sites[SITE].blocked = true;
    newer.state.browserConfigRevisions.browserPermissionConfigV2 += 1;
    localStorage.setItem('abu-settings', JSON.stringify(newer));
    const write = vi.spyOn(localStorage, 'setItem');
    expect(await useSettingsStore.getState().setBrowserSiteRule(SITE, browsing, browsing)).toBe('conflict');
    expect(write).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('abu-settings')!).state.browserPermissionConfigV2.sites[SITE].blocked).toBe(true);
  });
  it('removes an all-default exception and refuses a stale deletion of a newer block', async () => {
    await useSettingsStore.getState().setBrowserSiteRule(SITE, browsing, null);
    expect(await useSettingsStore.getState().setBrowserSiteRule(SITE, emptyBrowserSiteRule(), browsing)).toBe('saved');
    expect(useSettingsStore.getState().browserPermissionConfigV2?.sites[SITE]).toBeUndefined();
    await useSettingsStore.getState().setBrowserSiteRule(SITE, browsing, null);
    await useSettingsStore.getState().setBrowserSiteBlocked(SITE, true);
    expect(await useSettingsStore.getState().removeBrowserSiteRule(SITE, browsing)).toBe(false);
    expect(useSettingsStore.getState().browserPermissionConfigV2?.sites[SITE].blocked).toBe(true);
  });
  it('cancels custom changes and deletion while both wait for the shared lock', async () => {
    await useSettingsStore.getState().setBrowserSiteRule(SITE, browsing, null);
    let release!: () => void;
    request('another-window', () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    let active = true;
    const save = useSettingsStore.getState().setBrowserSiteRule(SITE, { ...browsing, upload: 'allow' }, browsing, () => active);
    const remove = useSettingsStore.getState().removeBrowserSiteRule(SITE, browsing, () => active);
    active = false;
    release();
    expect(await save).toBe('failed');
    expect(await remove).toBe(false);
    expect(useSettingsStore.getState().browserPermissionConfigV2?.sites[SITE]).toEqual(browsing);
  });
});

describe('scoped grants and V53 hydration', () => {
  const top = 'https://app.example';
  const other = 'https://other.example';
  const rule = { browse: 'allow' as const, upload: 'ask' as const, script: 'deny' as const };

  it('writes a resource grant only to its host scope', async () => {
    expect(await useSettingsStore.getState().setBrowserSiteResourcePermission(SITE, 'upload', 'allow', undefined, top)).toBe(true);
    const config = readConfirmedBrowserPermissionConfig(useSettingsStore.getState());
    expect(config.sites[SITE]).toBeUndefined();
    expect(config.embeddedSites[top][SITE].upload).toBe('allow');
    expect(config.embeddedSites[other]).toBeUndefined();
  });

  it('edits and deletes one scoped rule without touching another host or a whole-site ban', async () => {
    await useSettingsStore.getState().setBrowserSiteBlocked(SITE, true);
    expect(await useSettingsStore.getState().setBrowserEmbeddedRule(top, SITE, rule, null)).toBe('saved');
    expect(await useSettingsStore.getState().setBrowserEmbeddedRule(other, SITE, rule, null)).toBe('saved');
    expect(await useSettingsStore.getState().setBrowserEmbeddedRule(top, SITE, null, rule)).toBe('saved');
    const config = readConfirmedBrowserPermissionConfig(useSettingsStore.getState());
    expect(config.embeddedSites[top]).toBeUndefined();
    expect(config.embeddedSites[other][SITE]).toEqual(rule);
    expect(config.sites[SITE].blocked).toBe(true);
  });

  it('refuses stale scoped deletion and malformed replacement', async () => {
    await useSettingsStore.getState().setBrowserEmbeddedRule(top, SITE, rule, null);
    await useSettingsStore.getState().setBrowserSiteResourcePermission(SITE, 'browse', 'deny', undefined, top);
    expect(await useSettingsStore.getState().setBrowserEmbeddedRule(top, SITE, null, rule)).toBe('conflict');
    const current = readConfirmedBrowserPermissionConfig(useSettingsStore.getState()).embeddedSites[top][SITE];
    expect(await useSettingsStore.getState().setBrowserEmbeddedRule(top, SITE, {} as typeof rule, current)).toBe('failed');
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState()).embeddedSites[top][SITE].browse).toBe('deny');
  });

  it('hydrates a V52 profile and persists V53 without losing denials or iframe scope', async () => {
    localStorage.setItem('abu-settings', JSON.stringify({ version: 52, state: {
      browserOperationPolicy: { readOnly: 'allow', interactive: 'allow', upload: 'deny', scripting: 'ask' },
      allowUnattendedBrowser: true,
      browserSitePermissions: { [top]: 'allowed', [SITE]: 'allowed', [other]: 'denied' },
      browserSiteGrantViaEmbed: { [SITE]: { [top]: true } },
      imChannel: { allowLanWebhook: false },
    } }));
    await useSettingsStore.persist.rehydrate();
    await drained();
    const blob = JSON.parse(localStorage.getItem('abu-settings')!);
    expect(blob.version).toBe(53);
    expect(blob.state.browserPermissionConfigV2.defaults).toEqual({ browse: 'ask', upload: 'deny', script: 'ask' });
    expect(blob.state.browserPermissionConfigV2.sites[other].blocked).toBe(true);
    expect(blob.state.browserPermissionConfigV2.sites[SITE]).toBeUndefined();
    expect(blob.state.browserPermissionConfigV2.embeddedSites[top][SITE]).toEqual({ browse: 'allow', upload: 'deny', script: 'ask' });
    expect(blob.state.imChannel.allowLanWebhook).toBe(false);
  });

  it('retains the dev LAN opt-in migration while adding browser migration', async () => {
    const migrate = useSettingsStore.persist.getOptions().migrate!;
    const result = await migrate({ imChannel: {}, browserOperationPolicy: { readOnly: 'allow', interactive: 'allow', upload: 'ask', scripting: 'ask' } }, 51);
    expect((result as Record<string, { allowLanWebhook: boolean }>).imChannel.allowLanWebhook).toBe(false);
    expect((result as Record<string, ReturnType<typeof createBrowserPermissionConfig>>).browserPermissionConfigV2.defaults.browse).toBe('ask');
  });

  it('does not interpret a damaged current profile as a legacy profile', async () => {
    localStorage.setItem('abu-settings', JSON.stringify({ version: 53, state: { browserSitePermissions: { [SITE]: 'denied' } } }));
    expect(initialBrowserPermissionConfig().defaults.browse).toBe('deny');
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().browserPermissionConfigV2.defaults.browse).toBe('deny');
    expect(useSettingsStore.getState().browserPermissionConfigV2.sites[SITE].blocked).toBe(true);
  });

  it('does not expose optimistic grants while the shared lock is pending', async () => {
    await useSettingsStore.getState().setBrowserPermissionDefault('upload', 'deny');
    let release!: () => void;
    request('other-window', () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const save = useSettingsStore.getState().setBrowserPermissionDefault('upload', 'allow');
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState()).defaults.upload).toBe('deny');
    release();
    expect(await save).toBe(true);
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState()).defaults.upload).toBe('allow');
  });

  it('fails closed if another window removes previously confirmed storage', async () => {
    await useSettingsStore.getState().setBrowserPermissionDefault('script', 'allow');
    localStorage.removeItem('abu-settings');
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState()).defaults.script).toBe('deny');
    expect(await useSettingsStore.getState().setBrowserPermissionDefault('browse', 'allow')).toBe(false);
    useSettingsStore.getState().setUserNickname('No grant restoration');
    await drained();
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState()).defaults.script).toBe('deny');
  });

  it.each(['ordinary', 'permission'])('retains a disk ban with a damaged revision during a %s edit', async (kind) => {
    await useSettingsStore.getState().setBrowserPermissionDefault('browse', 'allow');
    const disk = JSON.parse(localStorage.getItem('abu-settings')!);
    disk.state.browserPermissionConfigV2.sites[SITE] = { ...emptyBrowserSiteRule(), blocked: true };
    disk.state.browserConfigRevisions.browserPermissionConfigV2 = 0;
    localStorage.setItem('abu-settings', JSON.stringify(disk));
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState()).sites[SITE].blocked).toBe(true);
    if (kind === 'ordinary') useSettingsStore.getState().setUserNickname('Test reader');
    else expect(await useSettingsStore.getState().setBrowserPermissionDefault('script', 'ask')).toBe(true);
    await drained();
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState()).sites[SITE]?.blocked).toBe(true);
    expect(useSettingsStore.getState().browserPermissionConfigV2.sites[SITE]?.blocked).toBe(true);
  });

  it('remembers observed storage even when the following write fails', async () => {
    localStorage.removeItem('abu-settings');
    __resetBrowserConfigPersistenceForTests();
    await useSettingsStore.persist.rehydrate();
    const config = createBrowserPermissionConfig();
    config.sites[SITE] = { ...emptyBrowserSiteRule(), blocked: true };
    localStorage.setItem('abu-settings', JSON.stringify({ version: 53, state: { browserPermissionConfigV2: config } }));
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    useSettingsStore.getState().setUserNickname('Failed save');
    await drained();
    write.mockRestore();
    localStorage.removeItem('abu-settings');
    expect(readConfirmedBrowserPermissionConfig(useSettingsStore.getState()).defaults.browse).toBe('deny');
  });
});


describe('confirmed multi-target approval save', () => {
  const HOST = 'https://host.example';
  it('saves the whole scoped approval in one write without changing other resource decisions', async () => {
    const write = vi.spyOn(localStorage, 'setItem');
    expect(await useSettingsStore.getState().grantBrowserPermissionTargets('upload', [{ origin: SITE, embeddedIn: HOST }], () => true)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const config = readConfirmedBrowserPermissionConfig(useSettingsStore.getState());
    expect(config.sites[SITE]).toBeUndefined();
    expect(config.sites[HOST]).toEqual({ ...emptyBrowserSiteRule(), upload: 'allow' });
    expect(config.embeddedSites[HOST][SITE]).toEqual({ browse: 'inherit', upload: 'allow', script: 'inherit' });
  });
  it.each(['cancelled', 'blocked'])('does not leave partial grants when %s while waiting for the lock', async (condition) => {
    let release!: () => void;
    request('external-window', () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    let active = true;
    const save = useSettingsStore.getState().grantBrowserPermissionTargets('upload', [{ origin: HOST }, { origin: SITE, embeddedIn: HOST }], () => active);
    const disk = JSON.parse(localStorage.getItem('abu-settings')!);
    if (condition === 'cancelled') active = false;
    else {
      disk.state.browserPermissionConfigV2.sites[SITE] = { ...emptyBrowserSiteRule(), blocked: true };
      localStorage.setItem('abu-settings', JSON.stringify(disk));
    }
    const before = localStorage.getItem('abu-settings');
    release();
    expect(await save).toBe(false);
    expect(localStorage.getItem('abu-settings')).toBe(before);
  });
  it('captures the prompt scope before waiting for the lock', async () => {
    let release!: () => void;
    request('external-window', () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const targets = [{ origin: SITE, embeddedIn: HOST }];
    const save = useSettingsStore.getState().grantBrowserPermissionTargets('upload', targets, () => true);
    targets[0].embeddedIn = 'https://different.example';
    targets.push({ origin: 'https://extra.example', embeddedIn: HOST });
    release();
    expect(await save).toBe(true);
    const config = readConfirmedBrowserPermissionConfig(useSettingsStore.getState());
    expect(Object.keys(config.embeddedSites)).toEqual([HOST]);
    expect(Object.keys(config.embeddedSites[HOST])).toEqual([SITE]);
  });
});
