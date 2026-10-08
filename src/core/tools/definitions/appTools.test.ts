import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exists, readDir, readTextFile } from '@tauri-apps/plugin-fs';
import { useAppStore } from '@/stores/appStore';
import { useAppDraftStore } from '@/stores/appDraftStore';
import { useTeamStore } from '@/stores/teamStore';
import { prepareAppTool } from './appTools';

let root: string;
let dir: string;
let myTeamId: string;

const templates = [{ id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' }];

function writeDraft(sceneRun: Record<string, string>) {
  mkdirSync(join(dir, '.abu-app'), { recursive: true });
  writeFileSync(join(dir, '.abu-app', 'app.json'), JSON.stringify({
    name: 'weekly-report', version: '1.0.0', minAbuVersion: '0.51.0',
    interface: { displayName: '周报', shortDescription: '每周五整理周报' },
    nav: { items: [{ id: 'chat', target: 'builtin:chat' }, { id: 'wiki', title: 'Wiki', target: 'url:https://wiki.example.com/team' }] },
    allowedOrigins: ['https://wiki.example.com'],
    home: { modes: { items: [{ modeId: 'write', title: '写周报', scenes: [
      { id: 'draft', title: '整理成周报', run: { expert: 'mine:周报整理员' }, templates },
      { id: 'retro', title: '复盘', run: sceneRun, templates },
    ] }] } },
  }));
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', '周报整理员.md'), '---\nname: 周报整理员\ndescription: 整理周报\n---\nTurn notes into a weekly report.\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abu-app-prepare-'));
  dir = join(root, 'draft');
  mkdirSync(dir, { recursive: true });
  vi.mocked(readTextFile).mockImplementation(async (p) => readFileSync(String(p), 'utf8'));
  vi.mocked(exists).mockImplementation(async (p) => existsSync(String(p)));
  vi.mocked(readDir).mockImplementation(async (p) => readdirSync(String(p), { withFileTypes: true }).map((d) => ({
    name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile(), isSymlink: d.isSymbolicLink(),
  })) as never);
  useAppStore.setState({ addedApps: [] });
  useAppDraftStore.setState({ draftsByConversation: { creator: { id: 'd'.repeat(32), dir, createdAt: '2026-09-28T00:00:00.000Z' } } });
  useTeamStore.setState({ teams: [] });
  myTeamId = useTeamStore.getState().createTeam({ name: '复盘小组', leaderRoleId: 'builtin:产品经理', memberRoleIds: ['builtin:产品经理', 'builtin:数据分析师'] }).id;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('app_prepare', () => {
  it('reads only the draft of the executing conversation and takes no arguments', async () => {
    await expect(prepareAppTool.execute({})).rejects.toThrow('app creation conversation');
    await expect(prepareAppTool.execute({ path: '/elsewhere' }, { conversationId: 'creator' })).rejects.toThrow('no arguments');
    await expect(prepareAppTool.execute({}, { conversationId: 'other' })).rejects.toThrow('not an app creation conversation');
  });

  it('reports the user\'s own experts and teams before anything is written', async () => {
    const result = JSON.parse(String(await prepareAppTool.execute({}, { conversationId: 'creator' })));
    expect(result.status).toBe('empty');
    expect(result.yours.teams).toEqual([{ id: myTeamId, name: '复盘小组' }]);
    expect(result.next).toContain('.abu-app/app.json');
  });

  it('returns what the preview will show once the draft is valid', async () => {
    writeDraft({ team: `mine:${myTeamId}` });
    const result = JSON.parse(String(await prepareAppTool.execute({}, { conversationId: 'creator' })));
    expect(result).toMatchObject({
      status: 'ready',
      name: 'weekly-report',
      title: '周报',
      newExperts: ['周报整理员'],
      newTeams: [],
      pages: ['https://wiki.example.com/team'],
    });
    expect(result.scenes).toEqual([
      { field: 'home.modes.items[0].scenes[0].run', mode: 'write', scene: 'draft', run: { expert: 'mine:周报整理员' } },
      { field: 'home.modes.items[0].scenes[1].run', mode: 'write', scene: 'retro', run: { team: `mine:${myTeamId}` } },
    ]);
  });

  it('hands the failing field back to the model', async () => {
    writeDraft({ team: 'mine:no-such-team' });
    await expect(prepareAppTool.execute({}, { conversationId: 'creator' })).rejects.toThrow('home.modes.items[0].scenes[1].run.team');
  });
});
