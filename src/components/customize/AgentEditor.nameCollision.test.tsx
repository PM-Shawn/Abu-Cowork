// @vitest-environment happy-dom
/**
 * The editor writes `~/.abu/agents/<name>/AGENT.md` unconditionally, and a
 * rename deletes the old folder. Before this guard, 手动创建 with an existing
 * expert's name silently replaced that expert (prompt and team identity gone),
 * and renaming A onto B's name replaced B and deleted A. A user agent named
 * like a builtin also shadowed it for every team pointing at `builtin:<name>`.
 * A new or renamed agent must therefore refuse any name another agent already
 * uses — compared case-insensitively, because the folders live on
 * case-insensitive file systems — without ever colliding with itself.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SubagentDefinition, SubagentMetadata } from '@/types';

vi.mock('@/utils/itemStorage', () => ({
  ITEM_EXISTS_CODE: 'ITEM_EXISTS',
  saveItemToAbuDir: vi.fn(async () => undefined),
}));

import { saveItemToAbuDir } from '@/utils/itemStorage';
import { agentRegistry } from '@/core/agent/registry';
import { getI18n } from '@/i18n';
import AgentEditor from './AgentEditor';

const reviewer: SubagentDefinition = {
  name: 'reviewer',
  description: 'Reviews code',
  systemPrompt: 'You review code.',
  filePath: '/Users/tester/.abu/agents/reviewer/AGENT.md',
  roleId: 'role-reviewer',
};

const known: SubagentMetadata[] = [
  { name: 'reviewer', description: 'Reviews code' },
  { name: 'writer', description: 'Writes docs' },
  // A disabled plugin's agent: its AGENT.md is still on disk.
  { name: 'weather-bot', description: 'Weather', source: { kind: 'plugin', plugin: 'weather@official' } },
];

const saveButton = (): HTMLButtonElement =>
  screen.getByText(getI18n().toolbox.agentSave).closest('button')! as HTMLButtonElement;
const nameInput = (): HTMLInputElement => screen.getByPlaceholderText('my-agent') as HTMLInputElement;
const takenHint = () => screen.queryByText(getI18n().toolbox.agentNameTakenHint);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(agentRegistry, 'getAvailableAgents').mockReturnValue(known);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentEditor — a new or renamed agent cannot take another agent\'s name', () => {
  it('blocks creating an agent under an existing agent\'s name: hint shown, save disabled, nothing written', async () => {
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'writer' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    await Promise.resolve();
    expect(vi.mocked(saveItemToAbuDir)).not.toHaveBeenCalled();
    // Disabled plugins' agents count too — their files are still there.
    expect(agentRegistry.getAvailableAgents).toHaveBeenCalledWith({ includeDisabledPlugins: true });
  });

  it('blocks a disabled plugin\'s agent name', () => {
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'weather-bot' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('blocks a builtin\'s name even before discovery has listed any agent', () => {
    vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([]);
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'abu' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('blocks renaming onto another agent\'s name', async () => {
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'writer' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    await Promise.resolve();
    expect(vi.mocked(saveItemToAbuDir)).not.toHaveBeenCalled();
  });

  it('compares case-insensitively (the folders are case-insensitive)', () => {
    vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'Writer', description: '' }]);
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'writer' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('allows renaming an agent to its own name in a different letter case, overwriting its own folder', async () => {
    const upper: SubagentDefinition = { ...reviewer, name: 'Reviewer', filePath: '/Users/tester/.abu/agents/Reviewer/AGENT.md' };
    vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'Reviewer', description: '' }, known[1]]);
    render(<AgentEditor agent={upper} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    // The default name mode lower-cases what is typed.
    fireEvent.change(nameInput(), { target: { value: 'reviewer' } });

    expect(takenHint()).toBeNull();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    const [, , savedName, , oldPath, options] = vi.mocked(saveItemToAbuDir).mock.calls[0];
    expect(savedName).toBe('reviewer');
    expect(oldPath).toBe(upper.filePath);
    expect(options).toEqual({ mustBeNew: false });
  });

  it('saves an agent whose unchanged name is, of course, its own', async () => {
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);

    expect(takenHint()).toBeNull();
    fireEvent.click(saveButton());

    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveItemToAbuDir).mock.calls[0][5]).toEqual({ mustBeNew: false });
  });

  it('allows a unique name, and asks the disk to refuse if one appeared meanwhile', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(nameInput(), { target: { value: 'fresh-agent' } });

    expect(takenHint()).toBeNull();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [folder, , savedName, , , options] = vi.mocked(saveItemToAbuDir).mock.calls[0];
    expect([folder, savedName]).toEqual(['agents', 'fresh-agent']);
    expect(options).toEqual({ mustBeNew: true });
  });

  it('shows the hint and does not close when the disk refuses the name at save time', async () => {
    vi.mocked(saveItemToAbuDir).mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'ITEM_EXISTS' }));
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(nameInput(), { target: { value: 'fresh-agent' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(takenHint()).not.toBeNull());
    expect(onSave).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);
  });
});
