// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ChatInput from './ChatInput';
import { clearAllComposerDrafts } from '@/stores/composerDraftStore';
import { useChatStore } from '@/stores/chatStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getI18n } from '@/i18n';

/**
 * The live `@` picker is ChatInput's own suggestion list — `AgentSelector` is
 * parked (its import is commented out), so provenance has to be visible here or
 * it is not visible at all.
 */
const AGENTS = [
  { name: 'weather', description: 'Forecasts', source: { kind: 'plugin' as const, plugin: 'weather@official' } },
  { name: 'planner', description: 'Plan work' },
];

function typeAtCaret(textarea: HTMLTextAreaElement, value: string): void {
  fireEvent.change(textarea, { target: { value } });
  textarea.setSelectionRange(value.length, value.length);
  fireEvent.select(textarea);
}

describe('ChatInput @ picker plugin provenance tag', () => {
  beforeEach(() => {
    clearAllComposerDrafts();
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    useChatStore.setState({
      conversations: {},
      conversationIndex: {},
      activeConversationId: null,
      pendingInput: null,
      pendingInputAppend: null,
      pendingReferences: [],
      pendingAttachmentRequests: [],
    });
    useDiscoveryStore.setState({ skills: [], agents: AGENTS, isLoading: false });
    useSettingsStore.setState({ composerEnterBehavior: 'enter', disabledAgents: [], disabledSkills: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useDiscoveryStore.setState({ skills: [], agents: [], isLoading: false });
  });

  it('tags only the plugin-provided agent row', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    typeAtCaret(screen.getByRole('textbox') as HTMLTextAreaElement, '@');

    const pluginRow = screen.getByRole('option', { name: /weather/ });
    const userRow = screen.getByRole('option', { name: /planner/ });

    const tag = within(pluginRow).getByTestId('agent-source-plugin');
    expect(tag.textContent).toBe(getI18n().chat.pickAgentPluginTag);
    expect(within(userRow).queryByTestId('agent-source-plugin')).toBeNull();
    expect(screen.getAllByTestId('agent-source-plugin')).toHaveLength(1);
  });

  it('shows no tag when no agent comes from a plugin', () => {
    useDiscoveryStore.setState({ agents: [{ name: 'planner', description: 'Plan work' }] });
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    typeAtCaret(screen.getByRole('textbox') as HTMLTextAreaElement, '@');

    expect(screen.getByRole('option', { name: /planner/ })).toBeTruthy();
    expect(screen.queryByTestId('agent-source-plugin')).toBeNull();
  });
});
