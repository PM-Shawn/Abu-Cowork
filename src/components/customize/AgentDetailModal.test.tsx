// @vitest-environment happy-dom
/**
 * A plugin-contributed agent's file belongs to the plugin: the next update
 * rewrites it. So the detail view has to say where the agent came from, and
 * must not offer an Edit that would be silently overwritten.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SubagentDefinition } from '@/types';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { getI18n, format } from '@/i18n';
import { usePluginStore } from '@/stores/pluginStore';
import AgentDetailModal from './AgentDetailModal';

const weather: InstalledPlugin = {
  key: 'weather@official',
  marketplace: 'official',
  name: 'Weather Pack',
  version: '1.2.0',
  installedAt: '2026-01-01T00:00:00.000Z',
  contributed: { skills: [], mcpServers: [], agents: ['reviewer'] },
};

function agent(source?: SubagentDefinition['source']): SubagentDefinition {
  return {
    name: 'reviewer',
    description: 'Reviews code',
    systemPrompt: 'You review code.',
    filePath: '/Users/tester/.abu/agents/reviewer/AGENT.md',
    source,
  };
}

function renderDetail(a: SubagentDefinition) {
  render(
    <AgentDetailModal
      agent={a}
      template={null}
      isInstalled
      onClose={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
}

const tb = () => getI18n().toolbox;
const editButton = () => screen.getByText(tb().agentEdit).closest('button')!;

beforeEach(() => {
  usePluginStore.setState({ installed: [weather] });
});

describe('AgentDetailModal — plugin provenance', () => {
  it('names the plugin by its display name and disables Edit', () => {
    renderDetail(agent({ kind: 'plugin', plugin: 'weather@official' }));

    expect(
      screen.getByText(format(tb().agentFromPlugin, { plugin: 'Weather Pack' })),
    ).toBeTruthy();

    const edit = editButton();
    expect(edit.hasAttribute('disabled')).toBe(true);
    expect(edit.getAttribute('title')).toBe(tb().agentFromPluginEditDisabled);
  });

  it('falls back to the key when no record matches (uninstalled mid-render)', () => {
    usePluginStore.setState({ installed: [] });
    renderDetail(agent({ kind: 'plugin', plugin: 'weather@official' }));
    expect(
      screen.getByText(format(tb().agentFromPlugin, { plugin: 'weather@official' })),
    ).toBeTruthy();
  });

  it('says nothing and keeps Edit enabled for a user-authored agent', () => {
    renderDetail(agent());
    expect(screen.queryByText(/来自插件|From plugin/)).toBeNull();
    expect(editButton().hasAttribute('disabled')).toBe(false);
  });
});
