// @vitest-environment happy-dom
/**
 * Deleting an expert removes its file and nothing else — the teams that list
 * it keep a roleId no agent answers to. Until now that was one silent click
 * behind the "…" menu. Every delete asks first, with one question: when at
 * least one team references the agent it names the teams; when none does it
 * names the expert.
 */

import type { ReactElement } from 'react';
import { render as renderBare, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';

// The detail window is a design-system dialog, so the section renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
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

/** Opens the expert's window and chooses 删除 in its 「…」 menu. What the entry does runs once the menu has gone. */
async function chooseDelete() {
  useDiscoveryStore.setState({ agents: [{ name: 'reviewer', description: 'Reviews code' }], skills: [], isLoading: false });
  // A user-authored expert lives on the 我的 shelf (市场 is the default).
  render(<AgentsSection source="mine" />);
  fireEvent.click(screen.getByText('reviewer'));
  const menuButton = [...document.querySelectorAll('button')].find((b) =>
    /ellipsis|more-horizontal/.test(b.querySelector('svg')?.getAttribute('class') ?? ''),
  );
  await userEvent.click(menuButton!);
  fireEvent.click(await screen.findByRole('menuitem', { name: tb().deleteItem }));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
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
    await chooseDelete();
    expect(await screen.findByText(format(tb().agentDeleteInTeamsTitle, { name: 'reviewer' }))).toBeTruthy();
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
    expect(screen.getByText(format(tb().agentDeleteInTeamsMessage, { count: '2', teams: '网页开发专家团、内容小队' }))).toBeTruthy();
    fireEvent.click(screen.getByText(tb().agentDeleteAnyway));
    await waitFor(() => expect(vi.mocked(fsRemove)).toHaveBeenCalledWith('/Users/tester/.abu/agents/reviewer', { recursive: true }));
  });

  it('says the team stops when the agent is a leader, not just one member short', async () => {
    useTeamStore.setState({ teams: [
      { id: 't1', name: '网页开发专家团', leaderRoleId: 'r-rev', memberRoleIds: ['r-rev', 'r-mem'], createdAt: 1 },
    ] });
    await chooseDelete();
    expect(await screen.findByText(format(tb().agentDeleteLeaderInTeamsMessage, { count: '1', teams: '网页开发专家团' }))).toBeTruthy();
    expect(screen.queryByText(format(tb().agentDeleteInTeamsMessage, { count: '1', teams: '网页开发专家团' }))).toBeNull();
  });

  it('cancelling keeps the agent', async () => {
    useTeamStore.setState({ teams: [{ id: 't1', name: '网页开发专家团', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-rev'], createdAt: 1 }] });
    await chooseDelete();
    fireEvent.click(await screen.findByText(getI18n().common.cancel));
    await waitFor(() => expect(screen.queryByText(format(tb().agentDeleteInTeamsTitle, { name: 'reviewer' }))).toBeNull());
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
    // The expert's window is still there.
    expect(screen.getByRole('dialog', { name: 'reviewer' })).toBeInTheDocument();
  });

  it('asks the plain delete question when no team references the agent, and deletes on 删除', async () => {
    await chooseDelete();
    // One question, and not the one about teams: no team lists the expert.
    const question = await screen.findByRole('alertdialog', { name: tb().deleteItem });
    expect(question).toHaveTextContent('reviewer');
    expect(screen.queryByText(format(tb().agentDeleteInTeamsTitle, { name: 'reviewer' }))).toBeNull();
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
    fireEvent.click(within(question).getByRole('button', { name: getI18n().common.delete }));
    await waitFor(() => expect(vi.mocked(fsRemove)).toHaveBeenCalledTimes(1));
    // The expert's own folder, with everything in it, and nothing else.
    expect(vi.mocked(fsRemove)).toHaveBeenCalledWith('/Users/tester/.abu/agents/reviewer', { recursive: true });
    // The list is read again once the folder has gone.
    const refresh = vi.mocked(useDiscoveryStore.getState().refresh);
    await waitFor(() => expect(refresh.mock.invocationCallOrder.at(-1)).toBeGreaterThan(vi.mocked(fsRemove).mock.invocationCallOrder[0]));
  });

  it('removes nothing until the question is answered, then exactly that expert’s folder once', async () => {
    useTeamStore.setState({ teams: [{ id: 't1', name: '网页开发专家团', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-rev'], createdAt: 1 }] });
    await chooseDelete();
    await screen.findByRole('alertdialog');
    expect(vi.mocked(fsRemove)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(tb().agentDeleteAnyway));
    await waitFor(() => expect(vi.mocked(fsRemove)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(fsRemove)).toHaveBeenCalledWith('/Users/tester/.abu/agents/reviewer', { recursive: true });
  });
});
