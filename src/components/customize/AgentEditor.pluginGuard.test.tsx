// @vitest-environment happy-dom
/**
 * The editor's only entry point (AgentsSection's "..." → Edit) is disabled for
 * a plugin-provided agent, because the next plugin update overwrites the file.
 * This pins the same invariant inside the save itself, so a future second entry
 * point cannot launder a plugin agent into a user-authored one.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SubagentDefinition } from '@/types';

vi.mock('@/utils/itemStorage', () => ({
  ITEM_EXISTS_CODE: 'ITEM_EXISTS',
  saveItemToAbuDir: vi.fn(async () => '/Users/tester/.abu/agents/reviewer/AGENT.md'),
}));

import { saveItemToAbuDir } from '@/utils/itemStorage';
import { getI18n } from '@/i18n';
import AgentEditor from './AgentEditor';

const base: SubagentDefinition = {
  name: 'reviewer',
  description: 'Reviews code',
  systemPrompt: 'You review code.',
  filePath: '/Users/tester/.abu/agents/reviewer/AGENT.md',
};

function clickSave(): void {
  fireEvent.click(screen.getByText(getI18n().toolbox.agentSave).closest('button')!);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentEditor — plugin-owned agents are not writable', () => {
  it('writes nothing when saving an agent a plugin provided', async () => {
    const onSave = vi.fn(async () => undefined);
    render(
      <AgentEditor
        agent={{ ...base, source: { kind: 'plugin', plugin: 'weather@official' } }}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    clickSave();

    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).not.toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('still saves a user-authored agent', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={base} onClose={vi.fn()} onSave={onSave} />);

    clickSave();

    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('saves the avatar selected from the shared picker', async () => {
    render(<AgentEditor agent={base} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getByTestId('avatar-option-code-purple'));
    clickSave();
    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveItemToAbuDir).mock.calls[0][3]).toContain('avatar: icon:code/purple');
  });

  it('shows the existing emoji and updates the avatar preview after choosing a preset', () => {
    render(<AgentEditor agent={{ ...base, avatar: '📊' }} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    const preview = screen.getByTestId('agent-editor-avatar-preview');
    expect(preview).toHaveTextContent('📊');
    fireEvent.click(screen.getByTestId('avatar-option-code-purple'));
    expect(preview.querySelector('[data-avatar-kind="icon"]')).not.toBeNull();
    expect(preview).not.toHaveTextContent('📊');
  });
});
