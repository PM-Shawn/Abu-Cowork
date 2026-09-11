// @vitest-environment happy-dom
/**
 * Editing an agent must not change WHO it is. `role-id` is the identity every
 * team membership points at and `created` drives the newest-first sort; both
 * are non-editable fields that a save has to carry over verbatim — the same
 * treatment `source` already gets. Before this test the editor rebuilt the
 * frontmatter from its form state and silently dropped both.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SubagentDefinition } from '@/types';

vi.mock('@/utils/itemStorage', () => ({
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
  roleId: 'role-abc123',
  createdAt: 1700000000000,
};

function clickSave(): void {
  fireEvent.click(screen.getByText(getI18n().toolbox.agentSave).closest('button')!);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentEditor — identity fields survive a save', () => {
  it('writes the existing role-id and created stamp back into AGENT.md', async () => {
    render(<AgentEditor agent={base} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);

    clickSave();

    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    const md = vi.mocked(saveItemToAbuDir).mock.calls[0][3];
    expect(md).toMatch(/role-id:\s*role-abc123/);
    expect(md).toMatch(/created:\s*1700000000000/);
  });

  it('writes no role-id for a brand-new agent (identity is minted on first team membership)', async () => {
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(screen.getByPlaceholderText('my-agent'), { target: { value: 'fresh' } });

    clickSave();

    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    const md = vi.mocked(saveItemToAbuDir).mock.calls[0][3];
    expect(md).not.toMatch(/role-id:/);
    expect(md).not.toMatch(/created:/);
  });
});
