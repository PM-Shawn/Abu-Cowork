import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exists, readDir, readTextFile } from '@tauri-apps/plugin-fs';
import type { SubagentDefinition } from '@/types';
import type { Team } from '@/stores/teamStore';
import { useAppStore } from '@/stores/appStore';
import { useAppDraftStore, type AppDraft } from '@/stores/appDraftStore';
import { draftFor, draftHasApp, draftRunLabel, readAppDraft } from './appDraft';
import type { RefCatalog } from './appRefs';

let root: string;
let draft: AppDraft;

function useRealTree() {
  vi.mocked(readTextFile).mockImplementation(async (p) => readFileSync(String(p), 'utf8'));
  vi.mocked(exists).mockImplementation(async (p) => existsSync(String(p)));
  vi.mocked(readDir).mockImplementation(async (p) => readdirSync(String(p), { withFileTypes: true }).map((d) => ({
    name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile(), isSymlink: d.isSymbolicLink(),
  })) as never);
}

const templates = [{ id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' }];

function writeApp(overrides: Record<string, unknown> = {}) {
  mkdirSync(join(draft.dir, '.abu-app'), { recursive: true });
  writeFileSync(join(draft.dir, '.abu-app', 'app.json'), JSON.stringify({
    name: 'weekly-report',
    version: '1.0.0',
    minAbuVersion: '0.51.0',
    interface: { displayName: '周报', shortDescription: '每周五整理周报' },
    home: { modes: { items: [{ modeId: 'write', title: '写周报', scenes: [
      { id: 'draft', title: '整理成周报', run: { expert: 'mine:周报整理员' }, templates },
      { id: 'retro', title: '复盘', run: { team: 'mine:weekly-review' }, templates },
      { id: 'data', title: '补数据', run: { expert: 'mine:我的分析师' }, templates },
      { id: 'jd', title: '招人', run: { team: 'builtin-team:recruiting' }, templates },
    ] }] } },
    ...overrides,
  }));
}

function writeExpert(name: string, body = 'Turn notes into a weekly report.') {
  mkdirSync(join(draft.dir, 'agents'), { recursive: true });
  writeFileSync(join(draft.dir, 'agents', `${name}.md`), `---\nname: ${name}\ndescription: 整理周报\n---\n${body}\n`);
}

function writeTeam(id: string, members: string[]) {
  mkdirSync(join(draft.dir, 'teams'), { recursive: true });
  writeFileSync(join(draft.dir, 'teams', `${id}.json`), JSON.stringify({ name: '周报复盘小组', leader: members[0], members, description: '整理和复盘' }));
}

const agent = (name: string, extra: Partial<SubagentDefinition> = {}): SubagentDefinition => ({
  name, description: name, filePath: `/home/u/.abu/agents/${name}/AGENT.md`, systemPrompt: 'x', ...extra,
} as SubagentDefinition);
const team = (id: string): Team => ({ id, name: id, leaderRoleId: 'l', memberRoleIds: ['l'], createdAt: 0 });

function catalog(): RefCatalog {
  const agents = new Map([agent('我的分析师'), agent('产品经理', { filePath: '__builtin__' })].map((item) => [item.name, item]));
  return {
    plugins: [],
    teams: [team('builtin-team:recruiting'), team('team-mine-1')],
    getAgent: (name) => agents.get(name),
    findManagedAgent: () => undefined,
    skillNames: new Set(),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abu-app-draft-'));
  draft = { id: 'd'.repeat(32), dir: join(root, 'draft'), createdAt: '2026-09-28T00:00:00.000Z' };
  mkdirSync(draft.dir, { recursive: true });
  useRealTree();
  useAppStore.setState({ addedApps: [] });
  useAppDraftStore.setState({ draftsByConversation: {} });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('draftFor', () => {
  it('finds the draft of a creation conversation and refuses any other conversation', () => {
    useAppDraftStore.getState().record('conv-1', draft);
    expect(draftFor('conv-1')).toEqual(draft);
    expect(() => draftFor('conv-2')).toThrow('not an app creation conversation');
  });
});

describe('readAppDraft', () => {
  it('reports an empty draft before the app file is written', async () => {
    expect(await draftHasApp(draft)).toBe(false);
    await expect(readAppDraft(draft, catalog())).rejects.toThrow('.abu-app/app.json');
    writeApp();
    expect(await draftHasApp(draft)).toBe(true);
  });

  it('reads the app, its new experts and teams, and labels scenes by the new names', async () => {
    writeApp();
    writeExpert('周报整理员');
    writeTeam('weekly-review', ['周报整理员', 'builtin:数据分析师']);
    const preview = await readAppDraft(draft, catalog());
    expect(preview.app).toMatchObject({ appId: 'weekly-report@mine', name: '周报', origin: { kind: 'created', authoringId: draft.id } });
    expect(preview.experts).toEqual([expect.objectContaining({ name: '周报整理员', description: '整理周报' })]);
    expect(preview.teams).toEqual([expect.objectContaining({ id: 'weekly-review', leaderRoleId: 'plugin:周报整理员' })]);
    const scenes = preview.app.config.home.modes.items[0]!.scenes;
    expect(draftRunLabel(scenes[0]!.run, preview)).toBe('周报整理员');
    expect(draftRunLabel(scenes[1]!.run, preview)).toBe('周报复盘小组');
    expect(draftRunLabel(scenes[2]!.run, preview)).toBeUndefined();
    expect(draftRunLabel(scenes[3]!.run, preview)).toBeUndefined();
  });

  it('names the field of a reference that exists nowhere', async () => {
    writeApp();
    writeExpert('周报整理员');
    await expect(readAppDraft(draft, catalog())).rejects.toMatchObject({ field: 'home.modes.items[0].scenes[1].run.team' });
  });

  it('refuses a new expert whose name is taken', async () => {
    writeApp();
    writeExpert('周报整理员');
    writeExpert('我的分析师');
    writeTeam('weekly-review', ['周报整理员', 'builtin:数据分析师']);
    await expect(readAppDraft(draft, catalog())).rejects.toMatchObject({ field: 'agents/我的分析师.md', reason: 'duplicate' });
  });

  it('refuses a new expert without instructions', async () => {
    writeApp();
    writeExpert('周报整理员', '   ');
    await expect(readAppDraft(draft, catalog())).rejects.toMatchObject({ field: 'agents/周报整理员.md' });
  });

  it('refuses a name another added app already has', async () => {
    writeApp();
    writeExpert('周报整理员');
    writeTeam('weekly-review', ['周报整理员', 'builtin:数据分析师']);
    useAppStore.setState({ addedApps: [{ appId: 'weekly-report@mine', name: '周报', config: (await readAppDraft(draft, catalog())).app.config, version: '1.0.0', origin: { kind: 'created', authoringId: 'other' }, plugins: [] }] });
    await expect(readAppDraft(draft, catalog())).rejects.toMatchObject({ field: 'name', reason: 'duplicate' });
  });

  it('refuses a draft that was already added', async () => {
    writeApp();
    await expect(readAppDraft({ ...draft, appId: 'weekly-report@mine' }, catalog())).rejects.toThrow('already been added');
  });
});
