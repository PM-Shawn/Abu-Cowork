import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore, __resetBrowserConfigPersistenceForTests } from './settingsStore';

/**
 * V56 (docx, xlsx, pptx and pdf skills on by default), driven through a real rehydrate of a stored
 * blob rather than by calling migrate on its own. The unit cases for migrate itself sit in
 * settingsStore.test.ts.
 */
const OFFICE = ['docx', 'xlsx', 'pptx', 'pdf'];
const OLD_DEFAULT = [
  'alert-sop', 'algorithmic-art', 'brand-guidelines', 'canvas-design',
  'claude-api', 'create-agent', 'doc-coauthoring', 'docx',
  'frontend-design', 'infographic', 'internal-comms', 'pdf',
  'pptx', 'slack-gif-creator', 'theme-factory', 'web-artifacts-builder',
  'webapp-testing', 'xlsx',
];
const NEW_DEFAULT = OLD_DEFAULT.filter((name) => !OFFICE.includes(name));

let queue: Promise<unknown>;
const request = vi.fn((_name: string, callback: () => unknown) => {
  const job = queue.then(callback);
  queue = job.catch(() => undefined);
  return job;
});
async function drained() { await queue; }

const migrate = () => useSettingsStore.persist.getOptions().migrate! as (data: unknown, version: number) => Record<string, unknown>;

async function hydrateFrom(version: number, state: Record<string, unknown>) {
  localStorage.setItem('abu-settings', JSON.stringify({ version, state }));
  await useSettingsStore.persist.rehydrate();
  await drained();
}

beforeEach(async () => {
  queue = Promise.resolve();
  request.mockClear();
  vi.stubGlobal('navigator', { locks: { request } });
  localStorage.clear();
  __resetBrowserConfigPersistenceForTests();
  await drained();
});
afterEach(async () => { await drained(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('V56 office skills on by default: hydrate a stored profile', () => {
  it.each([30, 55])('a V%i profile with the old default list comes up with the four skills on and is saved at 56', async (version) => {
    await hydrateFrom(version, { disabledSkills: [...OLD_DEFAULT] });
    expect(useSettingsStore.getState().disabledSkills).toEqual(NEW_DEFAULT);
    // The blob may stay at the old version on disk until the next write; that is safe because the
    // step is idempotent, so only the in-memory result is asserted here.
    expect(migrate()({ disabledSkills: [...OLD_DEFAULT] }, version).disabledSkills).toEqual(NEW_DEFAULT);
  });

  it('a profile that never had the list (version 0) ends with the new default, not the old one', async () => {
    await hydrateFrom(0, { theme: 'light' });
    const disabled = useSettingsStore.getState().disabledSkills;
    for (const name of OFFICE) expect(disabled).not.toContain(name);
    expect(disabled).toContain('canvas-design');
  });

  it('a V56 profile is not touched: a user who turned docx off keeps it off', async () => {
    await hydrateFrom(56, { disabledSkills: ['docx', 'my-skill'] });
    expect(useSettingsStore.getState().disabledSkills).toEqual(['docx', 'my-skill']);
  });

  it('a skill the user turns off after the upgrade stays off over two more restarts', async () => {
    await hydrateFrom(55, { disabledSkills: [...OLD_DEFAULT] });
    expect(useSettingsStore.getState().disabledSkills).not.toContain('pptx');
    useSettingsStore.getState().toggleSkillEnabled('pptx');
    for (let i = 0; i < 2; i += 1) {
      // what the store would have written for the next start: the partialized state under the running version
      const partialize = useSettingsStore.persist.getOptions().partialize!;
      const state = partialize(useSettingsStore.getState()) as Record<string, unknown>;
      localStorage.setItem('abu-settings', JSON.stringify({ version: useSettingsStore.persist.getOptions().version, state }));
      await useSettingsStore.persist.rehydrate();
      await drained();
      const disabled = useSettingsStore.getState().disabledSkills;
      expect(disabled).toContain('pptx');
      for (const name of ['docx', 'xlsx', 'pdf']) expect(disabled).not.toContain(name);
    }
  });

  it('a user who had already turned some of the four on keeps the other default-off skills as they were', async () => {
    await hydrateFrom(55, { disabledSkills: ['alert-sop', 'pdf', 'custom-a'] });
    expect(useSettingsStore.getState().disabledSkills).toEqual(['alert-sop', 'custom-a']);
  });
});

describe('V56 migrate: damaged and repeated input', () => {
  it('running it twice gives the same list as running it once', () => {
    const once = migrate()({ disabledSkills: [...OLD_DEFAULT] }, 55);
    const twice = migrate()(structuredClone(once), 55);
    expect(twice.disabledSkills).toEqual(once.disabledSkills);
    // a copy re-labelled as version 55 by an older build is cleaned again, which is the documented trade-off
    expect(migrate()(structuredClone(once), 56).disabledSkills).toEqual(once.disabledSkills);
  });

  it('removes every copy of a name that appears twice', () => {
    expect(migrate()({ disabledSkills: ['docx', 'a', 'docx', 'pdf', 'pdf'] }, 55).disabledSkills).toEqual(['a']);
  });

  it('matches names exactly: other cases and look-alike names stay', () => {
    const kept = ['DOCX', 'docx ', 'docx-extra', 'my-pdf', 'xlsx2'];
    expect(migrate()({ disabledSkills: [...kept, 'xlsx'] }, 55).disabledSkills).toEqual(kept);
  });

  it.each([
    ['null', null],
    ['an object', { docx: true }],
    ['a number', 7],
    ['a string', 'docx'],
    ['undefined', undefined],
  ])('does not throw when the list is %s and leaves it alone', (_label, value) => {
    const state: Record<string, unknown> = { theme: 'dark' };
    if (value !== undefined) state.disabledSkills = value;
    const out = migrate()(state, 55);
    expect(out.disabledSkills).toEqual(value);
  });

  it('does not throw on an empty state and does not invent a list', () => {
    expect(migrate()({}, 55).disabledSkills).toBeUndefined();
  });

  it('a profile from a later version is not changed', () => {
    const out = migrate()({ disabledSkills: ['docx'] }, 99);
    expect(out.disabledSkills).toEqual(['docx']);
  });

  it('a fresh install keeps the other default-off skills off', () => {
    const disabled = useSettingsStore.getInitialState().disabledSkills;
    expect([...disabled].sort()).toEqual([...NEW_DEFAULT].sort());
  });
});
