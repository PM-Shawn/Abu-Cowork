// @vitest-environment happy-dom
/**
 * Deleting an expert removes its file and nothing else — the teams that list
 * it keep a roleId no agent answers to. Until now that was one silent click
 * behind the "…" menu. When at least one team references the agent, the
 * delete asks first and names the teams; when none does, behaviour is
 * unchanged (no dialog).
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SubagentDefinition } from '@/types';

vi.mock('@/core/agent/registry', () => ({
  agentRegistry: { getAgent: vi.fn(), getAvailableAgents: vi.fn(() => []) },
}));

vi.mock('@/core/plugin/installedStore', async (importOriginal) => {
  const readInstalled = vi.fn(async (_home: string) => [] as import('@/core/plugin/installedStore').InstalledPlugin[]);
  return {
    ...(await importOriginal<typeof import('@/core/plugin/installedStore')>()),
    readInstalled,
    readInstalledResult: vi.fn(async (home: string) => ({ ok: true, plugins: await readInstalled(home) })),
  };
});

import { remove as fsRemove } from '@tauri-apps/plugin-fs';
import { agentRegistry } from '@/core/agent/registry';
import { getI18n, format } from '@/i18n';
import { usePluginStore } from '@/stores/pluginStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTeamStore } from '@/stores/teamStore';
import AgentsSection from './AgentsSection';

const definition: SubagentDefinition = {
  name: 'reviewer',
  description: 'Reviews code',
  systemPrompt: 'You review code.',
  filePath: '/Users/tester/.abu/agents/reviewer/AGENT.md',
  roleId: 'r-rev',
};

const tb = () => getI18n().toolbox;

function openMenu() {
  useDiscoveryStore.setState({ agents: [{ name: 'reviewer', description: 'Reviews code' }], skills: [], isLoading: false });
  render(<AgentsSection />);
  fireEvent.click(screen.getByText('reviewer'));
  const menuButton = [...document.querySelectorAll('button')].find((b) =>
    /ellipsis|more-horizontal/.test(b.querySelector('svg')?.getAttribute('class') ?? ''),
  );
  fireEvent.click(menuButton!);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentRegistry.getAgent).mockReturnValue(definition);
  usePluginStore.setState({ installed: [] });
  useSettingsStore.setState({ extensionsSearchQueries: { plugins: '', skills: '', mcp: '' }, disabledAgents: [] });
  useDiscoveryStore.setState({ refresh: vi.fn(async () => undefined) });
  useTeamStore.setState({ teams: [] });
});

describe('AgentsSection — deleting an agent that teams reference', () => {
  it('asks first and names the teams; confirming deletes', async () => {
    useTeamStore.setState({ teams: [
      { id: 't1', name: '网页开发专家团', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-rev'], createdAt: 1 },
      { id: 't2', name: '内容小队', leaderRoleId: 'r-other', memberRoleIds: ['r-other', 'r-rev'], createdAt: 2 },
    ] });
    openMenu();
    fireEvent.click(screen.getByText(tb().uninstall));
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
    expect(screen.getByText(format(tb().agentDeleteInTeamsTitle, { name: 'reviewer' }))).toBeTruthy();
    expect(screen.getByText(format(tb().agentDeleteInTeamsMessage, { count: '2', teams: '网页开发专家团、内容小队' }))).toBeTruthy();
    fireEvent.click(screen.getByText(tb().agentDeleteAnyway));
    await waitFor(() => expect(vi.mocked(fsRemove)).toHaveBeenCalledWith('/Users/tester/.abu/agents/reviewer', { recursive: true }));
  });

  it('says the team stops when the agent is a leader, not just one member short', () => {
    useTeamStore.setState({ teams: [
      { id: 't1', name: '网页开发专家团', leaderRoleId: 'r-rev', memberRoleIds: ['r-rev', 'r-mem'], createdAt: 1 },
    ] });
    openMenu();
    fireEvent.click(screen.getByText(tb().uninstall));
    expect(screen.getByText(format(tb().agentDeleteLeaderInTeamsMessage, { count: '1', teams: '网页开发专家团' }))).toBeTruthy();
    expect(screen.queryByText(format(tb().agentDeleteInTeamsMessage, { count: '1', teams: '网页开发专家团' }))).toBeNull();
  });

  it('cancelling keeps the agent', () => {
    useTeamStore.setState({ teams: [{ id: 't1', name: '网页开发专家团', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-rev'], createdAt: 1 }] });
    openMenu();
    fireEvent.click(screen.getByText(tb().uninstall));
    fireEvent.click(screen.getByText(getI18n().common.cancel));
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
    expect(screen.queryByText(format(tb().agentDeleteInTeamsTitle, { name: 'reviewer' }))).toBeNull();
  });

  it('deletes without a dialog when no team references the agent (unchanged behaviour)', async () => {
    openMenu();
    fireEvent.click(screen.getByText(tb().uninstall));
    await waitFor(() => expect(vi.mocked(fsRemove)).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(format(tb().agentDeleteInTeamsTitle, { name: 'reviewer' }))).toBeNull();
  });
});
