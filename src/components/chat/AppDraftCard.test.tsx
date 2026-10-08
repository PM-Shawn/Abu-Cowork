// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exists, readDir, readTextFile } from '@tauri-apps/plugin-fs';
import { initLanguage } from '@/i18n';
import { useAppStore } from '@/stores/appStore';
import { useAppDraftStore } from '@/stores/appDraftStore';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import AppDraftCard from './AppDraftCard';

let root: string;
let dir: string;
let myTeamId: string;

const templates = [{ id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' }];

function writeDraft(retroTeam: string) {
  mkdirSync(join(dir, '.abu-app'), { recursive: true });
  writeFileSync(join(dir, '.abu-app', 'app.json'), JSON.stringify({
    name: 'weekly-report', version: '1.0.0', minAbuVersion: '0.51.0',
    interface: { displayName: '周报', shortDescription: '每周五整理周报' },
    home: { header: { title: '这周做了什么？' }, modes: { items: [{ modeId: 'write', title: '写周报', scenes: [
      { id: 'draft', title: '整理成周报', run: { expert: 'mine:周报整理员' }, templates },
      { id: 'retro', title: '复盘', run: { team: retroTeam }, templates },
    ] }] } },
  }));
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', '周报整理员.md'), '---\nname: 周报整理员\ndescription: 把记录整理成周报\n---\nTurn notes into a weekly report.\n');
}

beforeEach(() => {
  initLanguage('zh-CN');
  root = mkdtempSync(join(tmpdir(), 'abu-app-draft-card-'));
  dir = join(root, 'draft');
  mkdirSync(dir, { recursive: true });
  vi.mocked(readTextFile).mockImplementation(async (p) => readFileSync(String(p), 'utf8'));
  vi.mocked(exists).mockImplementation(async (p) => existsSync(String(p)));
  vi.mocked(readDir).mockImplementation(async (p) => readdirSync(String(p), { withFileTypes: true }).map((d) => ({
    name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile(), isSymlink: d.isSymbolicLink(),
  })) as never);
  useAppStore.setState({ addedApps: [], managedApps: {} });
  useAppDraftStore.setState({ draftsByConversation: { creator: { id: 'd'.repeat(32), dir, createdAt: '2026-09-28T00:00:00.000Z' } } });
  useTeamStore.setState({ teams: [] });
  myTeamId = useTeamStore.getState().createTeam({ name: '复盘小组', leaderRoleId: 'builtin:产品经理', memberRoleIds: ['builtin:产品经理', 'builtin:数据分析师'] }).id;
});

afterEach(() => {
  cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe('AppDraftCard', () => {
  it('shows the home, who handles each scene and the experts that will be created', async () => {
    writeDraft(`mine:${myTeamId}`);
    render(<AppDraftCard conversationId="creator" toolCallId="call-1" />);
    expect(await screen.findByTestId('app-draft-scene-draft')).toHaveTextContent('整理成周报由 周报整理员 负责');
    expect(screen.getByTestId('app-draft-card')).toHaveTextContent('首页 · 这周做了什么？');
    expect(screen.getByTestId('app-draft-scene-retro')).toHaveTextContent('由 复盘小组 负责');
    expect(screen.getByTestId('app-draft-new-experts')).toHaveTextContent('周报整理员');
    expect(screen.queryByTestId('app-draft-new-teams')).not.toBeInTheDocument();
  });

  it('puts the caret back in the composer on 修改', async () => {
    writeDraft(`mine:${myTeamId}`);
    render(<AppDraftCard conversationId="creator" toolCallId="call-1" />);
    const before = useChatStore.getState().composerFocusRequest;
    fireEvent.click(await screen.findByTestId('app-draft-modify'));
    expect(useChatStore.getState().composerFocusRequest).toBe(before + 1);
  });

  it('says what is wrong when the draft no longer passes', async () => {
    writeDraft('mine:gone');
    render(<AppDraftCard conversationId="creator" toolCallId="call-1" />);
    expect(await screen.findByText('预览没能打开')).toBeInTheDocument();
    expect(screen.getByTestId('app-draft-card')).toHaveTextContent('home.modes.items[0].scenes[1].run.team');
    expect(screen.queryByTestId('app-draft-confirm')).not.toBeInTheDocument();
  });

  it('shows the added app once the draft was confirmed', () => {
    useAppDraftStore.setState({ draftsByConversation: { creator: { id: 'd'.repeat(32), dir, createdAt: '2026-09-28T00:00:00.000Z', appId: 'weekly-report@mine' } } });
    useAppStore.setState({ addedApps: [{ appId: 'weekly-report@mine', name: '周报', config: DEFAULT_APP_CONFIG, version: '1.0.0', origin: { kind: 'created', authoringId: 'd'.repeat(32) }, plugins: [] }] });
    render(<AppDraftCard conversationId="creator" toolCallId="call-1" />);
    expect(screen.getByTestId('app-draft-card')).toHaveTextContent('已添加「周报」');
    expect(screen.queryByTestId('app-draft-confirm')).not.toBeInTheDocument();
  });
});
